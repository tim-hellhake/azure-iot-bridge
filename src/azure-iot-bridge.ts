/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import {Database, Adapter, Device, AddonManager, Manifest} from 'gateway-addon';
import {WebThingsClient, Device as DeviceInfo} from 'webthings-client';
import {Registry, ConnectionString} from 'azure-iothub';
import {Client, Twin} from 'azure-iot-device';
import {Amqp} from 'azure-iot-device-amqp';
import {v4} from 'uuid';
import {client as WebSocketClient} from 'websocket';

interface Config {
    devices: Devices
}

interface Devices {
    [key: string]: DeviceConfig
}

interface DeviceConfig {
    primaryKey: string
}

interface ThingEvent {
    messageType: string,
    data: Record<string, unknown>
}

class IotHub extends Device {
    private database: Database;

    private registry: Registry;

    private hubHostName: string;

    constructor(adapter: Adapter, private manifest: Manifest) {
      super(adapter, manifest.name);
      this['@context'] = 'https://iot.mozilla.org/schemas/';
      this.name = manifest.display_name;
      this.description = manifest.display_name;
      this.database = new Database(manifest.name);

      const {
        accessToken,
        hubConnectionString,
      } = manifest.moziot.config;

      this.registry = Registry.fromConnectionString(hubConnectionString);
      const {
        HostName,
      } = ConnectionString.parse(hubConnectionString);

      if (!HostName) {
        throw `Invalid hub connection string, could not extract hostname`;
      }

      this.hubHostName = HostName;

      (async () => {
        const webThingsClient = await WebThingsClient.local(accessToken);
        const devices = await webThingsClient.getDevices();

        for (const device of devices) {
          try {
            const parts = device.href.split('/');
            const deviceId = parts[parts.length - 1];

            let accessKey = await this.loadPrimaryKey(deviceId);

            if (!accessKey) {
              accessKey = await this.createDevice(deviceId);
              await this.savePrimaryKey(deviceId, accessKey);
            }

            let twin;

            try {
              twin = await this.getTwin(deviceId, accessKey);
            } catch (error) {
              console.log(`Could not get twin: ${error}`);
              console.log(`Attempting to recreate device ${deviceId}`);
              accessKey = await this.createDevice(deviceId);
              await this.savePrimaryKey(deviceId, accessKey);
              twin = await this.getTwin(deviceId, accessKey);
            }

            await this.updateTwinFromDevice(
              deviceId, device, webThingsClient, twin);
            this.connect(deviceId, device, twin);
          } catch (e) {
            console.log(`Could not process device ${device.title} ${e}`);
          }
        }
      })();
    }

    private async loadPrimaryKey(deviceId: string): Promise<string | null> {
      console.log(`Loading primary key for ${deviceId}`);
      await this.database.open();
      const config = <Config><unknown> await this.database.loadConfig();

      if (config.devices && config.devices[deviceId]) {
        return config.devices[deviceId].primaryKey;
      }

      return null;
    }

    private async createDevice(deviceId: string): Promise<string> {
      console.log(`Creating device for ${deviceId}`);
      const primaryKey = new Buffer(v4()).toString('base64');
      const secondaryKey = new Buffer(v4()).toString('base64');

      await this.registry.addDevices([{
        deviceId,
        status: 'disabled',
        authentication: {
          symmetricKey: {
            primaryKey,
            secondaryKey,
          },
        },
      }]);

      return primaryKey;
    }

    private async savePrimaryKey(deviceId: string, primaryKey: string) {
      console.log(`Saving primary key for ${deviceId}`);
      await this.database.open();
      const config = <Config><unknown> await this.database.loadConfig();
      config.devices = config.devices || {};
      config.devices[deviceId] = {
        primaryKey,
      };
      await this.database.saveConfig(<Record<string, unknown>><unknown>config);
    }

    private async getTwin(deviceId: string, accessKey: string): Promise<Twin> {
      console.log(`Getting twin for ${deviceId}`);
      // eslint-disable-next-line max-len
      const deviceConnectionString = `HostName=${this.hubHostName};DeviceId=${deviceId};SharedAccessKey=${accessKey}`;
      const client = Client.fromConnectionString(deviceConnectionString, Amqp);

      await client.open();
      console.log(`Opened connection to device ${deviceId}`);
      return client.getTwin();
    }

    // eslint-disable-next-line max-len
    private async updateTwinFromDevice(deviceId: string, device: DeviceInfo, webThingsClient: WebThingsClient, twin: Twin) {
      console.log(`Update twin for ${deviceId}`);
      const patch: { [key: string]: string } = {};

      for (const propertyName in device.properties) {
        const property = device.properties[propertyName];
        const value = await webThingsClient.getProperty(property, propertyName);
        patch[propertyName] = value;
      }

      twin.properties.reported.update(patch, (error: string) => {
        if (error) {
          console.log(`Could not update twin for ${deviceId}: ${error}`);
        } else {
          console.log(`Updated twin for ${deviceId}`);
        }
      });
    }

    private connect(deviceId: string, device: DeviceInfo, twin: Twin) {
      console.log(`Connecting to websocket of ${deviceId}`);
      const {
        accessToken,
      } = this.manifest.moziot.config;

      const thingUrl = `ws://localhost:8080${device.href}`;
      const webSocketClient = new WebSocketClient();

      webSocketClient.on('connectFailed', function(error) {
        console.error(`Could not connect to ${thingUrl}: ${error}`);
      });

      webSocketClient.on('connect', function(connection) {
        console.log(`Connected to ${thingUrl}`);

        connection.on('error', function(error) {
          console.log(`Connection to ${thingUrl} failed: ${error}`);
        });
        connection.on('close', function() {
          console.log(`Connection to ${thingUrl} closed`);
        });
        connection.on('message', function(message) {
          if (message.type === 'utf8' && message.utf8Data) {
            const thingEvent = <ThingEvent>JSON.parse(message.utf8Data);

            if (thingEvent.messageType === 'propertyStatus') {
              console.log(
                `Update ${JSON.stringify(thingEvent.data)} in ${deviceId}`);
              twin.properties.reported.update(
                thingEvent.data, (error: string) => {
                  if (error) {
                    console.log(
                      `Could not update twin for ${deviceId}: ${error}`);
                  } else {
                    console.log(`Updated twin for ${deviceId}`);
                  }
                });
            }
          }
        });
      });

      webSocketClient.connect(`${thingUrl}?jwt=${accessToken}`);
    }
}

export class AzureIotBridge extends Adapter {
  constructor(addonManager: AddonManager, manifest: Manifest) {
    super(addonManager, AzureIotBridge.name, manifest.name);
    addonManager.addAdapter(this);
    new IotHub(this, manifest);
  }
}
