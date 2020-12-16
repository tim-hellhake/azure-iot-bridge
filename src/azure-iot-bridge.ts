/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import {Database, Adapter, Device, AddonManager, Manifest} from 'gateway-addon';
import {WebThingsClient} from 'webthings-client';
import {Registry, ConnectionString} from 'azure-iothub';
import {Client, Twin} from 'azure-iot-device';
import {Amqp} from 'azure-iot-device-amqp';
import {v4} from 'uuid';

interface Config {
    devices: Devices
}

interface Devices {
    [key: string]: DeviceConfig
}

interface DeviceConfig {
    primaryKey: string
}

class IotHub extends Device {
    private database: Database;

    private registry: Registry;

    private hubHostName: string;

    private twinByDeviceId: Record<string, Twin> = {};

    private batchByDeviceId: Record<string, Record<string, unknown>> = {};

    constructor(adapter: Adapter, manifest: Manifest) {
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
        await webThingsClient.connect();
        webThingsClient.on('propertyChanged', async (
          deviceId: string, key: string, value: unknown) => {
          console.log(`Updating ${key}=${value} in ${deviceId}`);

          let batch = this.batchByDeviceId[deviceId];

          if (!batch) {
            console.log(`Creating batch for ${deviceId}`);
            batch = {[key]: value};
            this.batchByDeviceId[deviceId] = batch;

            const twin = await this.getOrCreateTwin(deviceId);

            delete this.batchByDeviceId[deviceId];

            console.log(`Applying ${JSON.stringify(batch)} to ${deviceId}`);

            twin.properties.reported.update(batch, (error: string) => {
              if (error) {
                console.log(
                  `Could not update twin of ${deviceId}: ${error}`);
              } else {
                console.log(`Updated twin of ${deviceId}`);
              }
            });
          } else {
            console.log(`Adding ${key}=${value} in ${deviceId} to batch`);
            batch[key] = value;
          }
        });
      })();
    }

    private async getOrCreateTwin(deviceId: string): Promise<Twin> {
      let twin = this.twinByDeviceId[deviceId];

      if (!twin) {
        let accessKey = await this.getOrCreateDevice(deviceId);

        try {
          twin = await this.getTwin(deviceId, accessKey);
        } catch (error) {
          console.log(`Could not get twin: ${error}`);
          console.log(`Attempting to recreate twin for ${deviceId}`);
          accessKey = await this.createDevice(deviceId);
          await this.savePrimaryKey(deviceId, accessKey);
          twin = await this.getTwin(deviceId, accessKey);
        }

        this.twinByDeviceId[deviceId] = twin;
      }

      return twin;
    }

    private async getOrCreateDevice(deviceId: string): Promise<string> {
      let accessKey = await this.loadPrimaryKey(deviceId);

      if (!accessKey) {
        accessKey = await this.createDevice(deviceId);
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

    private async createDevice(deviceId: string): Promise<string> {
      console.log(`Creating twin for ${deviceId}`);
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
}

export class AzureIotBridge extends Adapter {
  constructor(addonManager: AddonManager, manifest: Manifest) {
    super(addonManager, AzureIotBridge.name, manifest.name);
    addonManager.addAdapter(this);
    new IotHub(this, manifest);
  }
}
