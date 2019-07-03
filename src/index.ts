/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import { AzureIotBridge } from './azure-iot-bridge';

export = (addonManager: any, manifest: any) => new AzureIotBridge(addonManager, manifest);
