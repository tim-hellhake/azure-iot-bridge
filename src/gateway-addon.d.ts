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

        constructor(adapter: Adapter, id: string);

        public addAction(name: string, metadata: any): void;
    }

    class Adapter {
        constructor(addonManager: any, id: string, packageName: string);

        public handleDeviceAdded(device: Device): void;
    }

    class Database {
        constructor(packageName: string, path?: string);
        public open(): Promise<void>;
        public loadConfig(): Promise<{}>;
        public saveConfig(config: {}): Promise<void>;
    }
}
