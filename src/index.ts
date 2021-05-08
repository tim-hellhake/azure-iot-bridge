/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import { AddonManagerProxy } from 'gateway-addon';
import { AzureIotBridge, Manifest } from './azure-iot-bridge';

export = function (
  addonManager: AddonManagerProxy,
  manifest: Manifest,
  errorCallback: // eslint-disable-next-line no-unused-vars
  (packageName: string, error: string) => void
): void {
  const { hubConnectionString, accessToken } = manifest.moziot.config;

  if (!hubConnectionString) {
    errorCallback(manifest.name, 'No hub connection string configured');
    return;
  }

  if (!accessToken) {
    errorCallback(manifest.name, 'No access token configured');
  }

  new AzureIotBridge(addonManager, manifest);
};
