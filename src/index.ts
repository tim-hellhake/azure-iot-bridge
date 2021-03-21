/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import {AddonManagerProxy} from 'gateway-addon';
import {AzureIotBridge, Manifest} from './azure-iot-bridge';

export = function(addonManager: AddonManagerProxy, manifest: Manifest): void {
  new AzureIotBridge(addonManager, manifest);
};
