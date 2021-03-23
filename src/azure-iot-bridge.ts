/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import {Database, Adapter, Device, AddonManagerProxy} from 'gateway-addon';
import {Property, WebThingsClient} from 'webthings-client';
import {Registry, ConnectionString} from 'azure-iothub';
import {Client, Twin, Message} from 'azure-iot-device';
import {Amqp} from 'azure-iot-device-amqp';
import {v4} from 'uuid';

export interface Manifest {
  name: string,
  display_name: string,
  moziot: {
    config: Record<string, string>
  }
}

interface Config {
    devices: Devices
}

interface Devices {
    [key: string]: DeviceConfig
}

interface DeviceConfig {
    primaryKey: string
}

function sanitizeNames(s: string) {
  return s
    .split('')
    .map((x) => x.replace(/[^a-zA-Z0-9-.+%_#*?!(),:=@$']/, '_'))
    .join('');
}

class IotHub extends Device {
    private database: Database;

    private registry: Registry;

    private hubHostName: string;

    private twinByDeviceId: Record<string, Twin> = {};

    private deviceByDeviceId: Record<string, Client> = {};

    private batchByDeviceId: Record<string, Record<string, unknown>> = {};

    constructor(adapter: Adapter, private manifest: Manifest) {
      super(adapter, manifest.name);
      this['@context'] = 'https://iot.mozilla.org/schemas/';
      this.setTitle(manifest.display_name);
      this.database = new Database(manifest.name, '');

      const {
        hubConnectionString,
      } = this.manifest.moziot.config;

      this.registry = Registry.fromConnectionString(hubConnectionString);

      const {
        HostName,
      } = ConnectionString.parse(hubConnectionString);

      if (!HostName) {
        throw `Invalid hub connection string, could not extract hostname`;
      }

      this.hubHostName = HostName;

      this.connectToGateway();
    }

    private async connectToGateway() {
      const {
        accessToken,
        updateTwin,
        minCheckDeviceStatusInterval,
      } = this.manifest.moziot.config;

      let deviceDisabled: Record<string, boolean> = await this.checkDeviceStatus();
      let lastDeviceCheck = new Date();

      const webThingsClient = await WebThingsClient.local(accessToken);
      const devices = await webThingsClient.getDevices();

      for (const device of devices) {
        const originalDeviceId = device.id();
        await device.connect();
        // eslint-disable-next-line max-len
        console.log(`Successfully connected to ${device.description.title} (${originalDeviceId})`);

        device.on('propertyChanged', async (property: Property, value: unknown) => {
          const key = property.name;
          const secondsSinceLastDeviceCheck =
          (new Date().getTime() - lastDeviceCheck.getTime()) / 1000;

          if (secondsSinceLastDeviceCheck > (minCheckDeviceStatusInterval || 0)) {
            lastDeviceCheck = new Date();
            console.log(`Time since last device update: ${secondsSinceLastDeviceCheck}s`);
            deviceDisabled = await this.checkDeviceStatus();
          }

          const deviceId = sanitizeNames(originalDeviceId);
          console.log(`Updating ${key}=${value} in ${deviceId}`);

          if (deviceDisabled[deviceId]) {
            console.log(`Device ${deviceId} is not enabled, ignoring update`);
            return;
          }

          let batch = this.batchByDeviceId[deviceId];

          if (!batch) {
            console.log(`Creating batch for ${deviceId}`);
            batch = {[key]: value};
            this.batchByDeviceId[deviceId] = batch;

            try {
              const device = await this.getOrCreateDevice(deviceId);
              const batchJson = JSON.stringify(batch);

              try {
                console.log(`Sending event ${batchJson} to ${deviceId}`);

                const message = new Message(batchJson);

                await device.sendEvent(message);

                console.log(`Sent event ${batchJson} to ${deviceId}`);
              } catch (e) {
                console.log(`Could not send event to ${deviceId}: ${e}`);
              }

              if (updateTwin) {
                try {
                  console.log(`Applying ${batchJson} to twin ${deviceId}`);
                  await this.updateTwin(deviceId, device, batch);
                  console.log(`Updated twin of ${deviceId} with ${batchJson}`);
                } catch (e) {
                  console.log(`Could not update twin of ${deviceId}: ${e}`);
                }
              }
            } catch (e) {
              console.log(`Could not create device for ${deviceId}: ${e}`);
            }

            delete this.batchByDeviceId[deviceId];
          } else {
            console.log(`Adding ${key}=${value} in ${deviceId} to batch`);
            batch[key] = value;
          }
        });
      }
    }

    private async checkDeviceStatus(): Promise<Record<string, boolean>> {
      const devices = (await this.registry.list()).responseBody;
      const deviceDisabled: Record<string, boolean> = {};

      for (const device of devices) {
        const {
          status,
        } = device;

        deviceDisabled[device.deviceId] = status !== 'enabled';
      }

      return deviceDisabled;
    }

    private async updateTwin(deviceId: string,
                             device: Client,
                             batch: Record<string, unknown>): Promise<void> {
      const twin = await this.getOrCreateTwin(deviceId, device);

      return new Promise((resolve, reject) => {
        twin.properties.reported.update(batch, (error: string) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }

    private async getOrCreateTwin(deviceId: string, device: Client): Promise<Twin> {
      let twin = this.twinByDeviceId[deviceId];

      if (!twin) {
        twin = await device.getTwin();
        this.twinByDeviceId[deviceId] = twin;
      }

      return twin;
    }

    private async getOrCreateDevice(deviceId: string): Promise<Client> {
      let device = this.deviceByDeviceId[deviceId];

      if (!device) {
        let accessKey = await this.getOrCreateDeviceKey(deviceId);

        try {
          device = await this.createDeviceClient(deviceId, accessKey);
        } catch (error) {
          console.log(`Could not create device: ${error}`);
          console.log(`Attempting to recreate device for ${deviceId}`);
          accessKey = await this.createDeviceKey(deviceId);
          await this.savePrimaryKey(deviceId, accessKey);
          device = await this.createDeviceClient(deviceId, accessKey);
        }

        this.deviceByDeviceId[deviceId] = device;
      }

      return device;
    }

    private async getOrCreateDeviceKey(deviceId: string): Promise<string> {
      let accessKey = await this.loadPrimaryKey(deviceId);

      if (!accessKey) {
        accessKey = await this.createDeviceKey(deviceId);
        await this.savePrimaryKey(deviceId, accessKey);
      }

      return accessKey;
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

    private async createDeviceKey(deviceId: string): Promise<string> {
      console.log(`Creating device for ${deviceId}`);
      const primaryKey = Buffer.from(v4()).toString('base64');
      const secondaryKey = Buffer.from(v4()).toString('base64');

      await this.registry.addDevices([{
        deviceId,
        status: 'enabled',
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

    private async createDeviceClient(deviceId: string, accessKey: string): Promise<Client> {
      console.log(`Creating device client for ${deviceId}`);
      // eslint-disable-next-line max-len
      const deviceConnectionString = `HostName=${this.hubHostName};DeviceId=${deviceId};SharedAccessKey=${accessKey}`;
      const client = Client.fromConnectionString(deviceConnectionString, Amqp);

      await client.open();
      console.log(`Opened connection to device ${deviceId}`);
      return client;
    }
}

export class AzureIotBridge extends Adapter {
  constructor(addonManager: AddonManagerProxy, manifest: Manifest) {
    super(addonManager, AzureIotBridge.name, manifest.name);
    addonManager.addAdapter(this);
    new IotHub(this, manifest);
  }
}
