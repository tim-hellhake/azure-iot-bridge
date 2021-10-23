/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import { Adapter, Device, AddonManagerProxy } from 'gateway-addon';
import { Property, WebThingsClient } from 'webthings-client';
import { Registry, ConnectionString } from 'azure-iothub';
import { Client, Twin, Message } from 'azure-iot-device';
import { Amqp } from 'azure-iot-device-amqp';
import { v4 } from 'uuid';
import { Config, Device as ConfigDevice } from './config';
import { loadConfig, saveConfig } from './config-database';

export interface Manifest {
  name: string;
  display_name: string;
  moziot: {
    config: Config;
  };
}

function sanitizeNames(s: string) {
  return s
    .split('')
    .map((x) => x.replace(/[^a-zA-Z0-9-.+%_#*?!(),:=@$']/, '_'))
    .join('');
}

class IotHub extends Device {
  private registry: Registry;

  private twinByDeviceId: Record<string, Twin> = {};

  private deviceByDeviceId: Record<string, Client> = {};

  private batchByDeviceId: Record<string, Record<string, unknown>> = {};

  constructor(adapter: Adapter) {
    super(adapter, 'azure-iot-bridge');
    this['@context'] = 'https://iot.mozilla.org/schemas/';
    this.setTitle('Azure IoT Bridge');
    this.registry = {} as unknown as Registry;
    this.start();
  }

  private async start() {
    const config = await loadConfig();
    const { hubConnectionString } = config;

    this.registry = Registry.fromConnectionString(hubConnectionString);

    const { HostName } = ConnectionString.parse(hubConnectionString);

    if (!HostName) {
      throw `Invalid hub connection string, could not extract hostname`;
    }

    await this.connectToGateway(HostName, config);
  }

  private async connectToGateway(hubHostName: string, config: Config) {
    const { accessToken, updateTwin, minCheckDeviceStatusInterval } = config;

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
          batch = { [key]: value };
          this.batchByDeviceId[deviceId] = batch;

          try {
            const device = await this.getOrCreateDevice(hubHostName, deviceId);
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
      const { status } = device;

      deviceDisabled[device.deviceId] = status !== 'enabled';
    }

    return deviceDisabled;
  }

  private async updateTwin(
    deviceId: string,
    device: Client,
    batch: Record<string, unknown>
  ): Promise<void> {
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

  private async getOrCreateDevice(hubHostName: string, deviceId: string): Promise<Client> {
    let device = this.deviceByDeviceId[deviceId];

    if (!device) {
      let accessKey = await this.getOrCreateDeviceKey(deviceId);

      try {
        device = await this.createDeviceClient(hubHostName, deviceId, accessKey);
      } catch (error) {
        console.log(`Could not create device: ${error}`);
        console.log(`Attempting to recreate device for ${deviceId}`);
        accessKey = await this.createDeviceKey(deviceId);
        await this.savePrimaryKey(deviceId, accessKey);
        device = await this.createDeviceClient(hubHostName, deviceId, accessKey);
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

  private async loadPrimaryKey(deviceId: string): Promise<string | undefined> {
    console.log(`Loading primary key for ${deviceId}`);
    const config = await loadConfig();
    const device = this.getDevice(deviceId, config.devices || []);

    return device?.primaryKey;
  }

  private async createDeviceKey(deviceId: string): Promise<string> {
    console.log(`Creating device for ${deviceId}`);
    const primaryKey = Buffer.from(v4()).toString('base64');
    const secondaryKey = Buffer.from(v4()).toString('base64');

    await this.registry.addDevices([
      {
        deviceId,
        status: 'enabled',
        authentication: {
          symmetricKey: {
            primaryKey,
            secondaryKey,
          },
        },
      },
    ]);

    return primaryKey;
  }

  private async savePrimaryKey(deviceId: string, primaryKey: string) {
    console.log(`Saving primary key for ${deviceId}`);
    const config = await loadConfig();
    const devices = config.devices || [];
    const existingDevice = this.getDevice(deviceId, devices);

    if (existingDevice) {
      existingDevice.primaryKey = primaryKey;
    } else {
      devices.push({ id: deviceId, primaryKey });
    }

    config.devices = devices;

    await saveConfig(config);
  }

  private getDevice(id: string, devices: ConfigDevice[]): ConfigDevice | null {
    for (const device of devices) {
      if (device.id === id) {
        return device;
      }
    }

    return null;
  }

  private async createDeviceClient(
    hubHostName: string,
    deviceId: string,
    accessKey: string
  ): Promise<Client> {
    console.log(`Creating device client for ${deviceId}`);
    // eslint-disable-next-line max-len
    const deviceConnectionString = `HostName=${hubHostName};DeviceId=${deviceId};SharedAccessKey=${accessKey}`;
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
    new IotHub(this);
  }
}
