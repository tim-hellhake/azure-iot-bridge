# Azure IoT bridge

[![Build Status](https://travis-ci.org/tim-hellhake/azure-iot-bridge.svg?branch=master)](https://travis-ci.org/tim-hellhake/azure-iot-bridge)
[![dependencies](https://david-dm.org/tim-hellhake/azure-iot-bridge.svg)](https://david-dm.org/tim-hellhake/azure-iot-bridge)
[![devDependencies](https://david-dm.org/tim-hellhake/azure-iot-bridge/dev-status.svg)](https://david-dm.org/tim-hellhake/azure-iot-bridge?type=dev)
[![optionalDependencies](https://david-dm.org/tim-hellhake/azure-iot-bridge/optional-status.svg)](https://david-dm.org/tim-hellhake/azure-iot-bridge?type=optional)
[![license](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](LICENSE)

Connect your devices to an Azure IoT Hub.

# How to use

1. Create an IoT Hub
2. Add the connection string from step 9 to the config
3. Go to http://[your-gateway]/oauth/authorize?response_type=code&client_id=local-token&scope=/things:readwrite
4. Create a token
5. Add the token to the config

# Create an IoT Hub

1. Go to https://portal.azure.com/#create/hub
2. Search for `IoT Hub`
3. Click on `Create`
4. Create your hub
5. Wait for the deployment to be finished
6. Under `Deployment detail`: click on our hub resource
7. Go to `Shared access policies`
8. Click on the `iothubowner`
9. Copy the `Connection string — primary key`
