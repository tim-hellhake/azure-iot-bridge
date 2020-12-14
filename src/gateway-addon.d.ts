/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

declare module 'gateway-addon' {
    class Device {
        protected '@context': string;

        protected name: string;

        protected description: string;

        constructor(_adapter: Adapter, _id: string);

        public addAction(
          _name: string, _metadata: Record<string, unknown>): void;
    }

    class Adapter {
      constructor(
        _addonManager: AddonManager, _id: string, _packageName: string);

      public handleDeviceAdded(_device: Device): void;
    }

    class Database {
      constructor(_packageName: string, _path?: string);

      public open(): Promise<void>;

      public loadConfig(): Promise<Record<string, unknown>>;

      public saveConfig(_config: Record<string, unknown>): Promise<void>;
    }

    class AddonManager {
      addAdapter(_adapter: Adapter): void;
    }

    interface Manifest {
      name: string,
      display_name: string,
      moziot: {
        config: Record<string, string>
      }
    }
}
