/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import { Database, Adapter, Device, } from 'gateway-addon';
import { WebThingsClient } from 'webthings-client';
import { Registry, ConnectionString } from 'azure-iothub';
import { Client } from 'azure-iot-device';
import { Amqp } from 'azure-iot-device-amqp';
import { v4 } from 'uuid';

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

    constructor(adapter: any, manifest: any) {
        super(adapter, manifest.name);
        this['@context'] = 'https://iot.mozilla.org/schemas/';
        this.name = manifest.display_name;
        this.description = manifest.description;
        this.database = new Database(manifest.name);

        const {
            accessToken,
            hubConnectionString
        } = manifest.moziot.config;

        const webThingsClient = new WebThingsClient("localhost", 8080, accessToken);
        const registry = Registry.fromConnectionString(hubConnectionString);
        const hubString = ConnectionString.parse(hubConnectionString);
        const hubHostName = hubString.HostName;

        (async () => {
            const devices = await webThingsClient.getDevices();

            for (const device of devices) {
                const parts = device.href.split('/');
                const deviceId = parts[parts.length - 1];

                let accessKey = await this.loadPrimaryKey(deviceId);

                if (!accessKey) {
                    const primaryKey = new Buffer(v4()).toString('base64');
                    const secondaryKey = new Buffer(v4()).toString('base64');

                    console.log(`Creating device ${deviceId}`);

                    await registry.addDevices([{
                        deviceId,
                        status: 'disabled',
                        authentication: {
                            symmetricKey: {
                                primaryKey,
                                secondaryKey
                            }
                        }
                    }]);

                    await this.savePrimaryKey(deviceId, primaryKey);

                    accessKey = primaryKey;
                }

                const deviceConnectionString = `HostName=${hubHostName};DeviceId=${deviceId};SharedAccessKey=${accessKey}`;
                const client = Client.fromConnectionString(deviceConnectionString, Amqp);

                await client.open();
                const twin = await client.getTwin();

                const patch: { [key: string]: string } = {};

                for (const propertyName in device.properties) {
                    const property = device.properties[propertyName];
                    const value = await webThingsClient.getProperty(property, propertyName);
                    patch[propertyName] = value;
                }

                await twin.properties.reported.update(patch);
            }
        })();
    }

    private async loadPrimaryKey(deviceId: string): Promise<string | undefined> {
        await this.database.open();
        const config = <Config>await this.database.loadConfig();

        if (config.devices && config.devices[deviceId]) {
            return config.devices[deviceId].primaryKey;
        }

        return undefined;
    }

    private async savePrimaryKey(deviceId: string, primaryKey: string) {
        await this.database.open();
        const config = <Config>await this.database.loadConfig();
        config.devices = config.devices || {};
        config.devices[deviceId] = {
            primaryKey
        };
        await this.database.saveConfig(config);
    }
}

export class AzureIotBridge extends Adapter {
    constructor(addonManager: any, manifest: any) {
        super(addonManager, AzureIotBridge.name, manifest.name);
        addonManager.addAdapter(this);
        const iotHub = new IotHub(this, manifest);
        this.handleDeviceAdded(iotHub);
    }
}
