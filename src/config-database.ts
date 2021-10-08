/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import { Database } from 'gateway-addon';
import { Config, Device } from './config';

interface ObsoleteConfig {
  accessToken: string;
  hubConnectionString: string;
  updateTwin: boolean;
  minCheckDeviceStatusInterval: boolean;
  devices?: Record<string, ObsoleteDevice>;
}

interface ObsoleteDevice {
  primaryKey: string;
}

const database = new Database('azure-iot-bridge', '');

export async function loadConfig(): Promise<Config> {
  await database.open();
  const config = (await database.loadConfig()) as unknown as ObsoleteConfig | Config;

  if (!Array.isArray(config.devices)) {
    const devices: Device[] = [];

    if (config.devices !== null && typeof config.devices === 'object') {
      for (const [key, value] of Object.entries(config.devices)) {
        devices.push({ id: key, ...value });
      }

      config.devices = devices;
      await saveConfig(config as Config);
    }
  }

  return config as Config;
}

export async function saveConfig(config: Config): Promise<void> {
  await database.open();
  await database.saveConfig(config);
}
