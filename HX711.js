"use strict";

const Gpio = require("pigpio").Gpio;
const microtime = require("microtime");
const sleep = require("sleep");

/**
 * GPIO pins references BCM pin numbers
 */
class HX711 {
  constructor(dataPin, clockPin, scale, channelGain) {
    this.__dataPin = new Gpio(dataPin, {
      mode: Gpio.INPUT,
      pullUpDown: Gpio.PUD_OFF
    });
    this.__clockPin = new Gpio(clockPin, {
      mode: Gpio.OUTPUT,
      pullUpDown: Gpio.PUD_OFF
    });
    this.__offset = 0;
    this.__scale = scale || 35;
    this.latestReading = -1337; // avoid undefined or null

    /**
     * Default Configurations
     */
    this.__channelGain = channelGain || HX711.CHANNEL_A_GAIN_128;

    /**
     * Binding of class methods
     */
    this.__isReady.bind(this);
    this.read.bind(this);
    this.readAverage.bind(this);
    this.__readRawAverage.bind(this);
    this.__readRaw.bind(this);
    this.__begin.bind(this);
    this.__applyNormalisation.bind(this);
    this.calibrateScale.bind(this);
    this.__setChannelGain.bind(this);
    // Initialises HX711 by taring
    this.__begin();
  }

  __begin() {
    if (this.__channelGain !== HX711.CHANNEL_A_GAIN_128) {
      this.__setChannelGain(this.__channelGain);
    }
    while (Math.abs(this.read()) >= 0.5) {
      this.tare();
    }
    return true;
  }

  __setChannelGain(channelGain, isInit) {
    let timesToPulse;

    if (channelGain === HX711.CHANNEL_A_GAIN_64) {
      timesToPulse = 3;
    } else if (channelGain === HX711.CHANNEL_B_GAIN_32) {
      timesToPulse = 2;
    } else {
      timesToPulse = 1;
    }

    if (isInit) {
      timesToPulse += 24;
    }

    /**
     * Wait for HX711 to be ready
     */
    while (isInit && !this.__isReady()) {
      sleep.msleep(1);
    }

    for (let timesPulsed = 0; timesPulsed < timesToPulse; timesPulsed++) {
      // start timer
      const startCounter = microtime.now();
      // request next bit from HX711
      this.__clockPin.digitalWrite(1);
      this.__clockPin.digitalWrite(0);
      // stop timer
      const endCounter = microtime.now();
      const timeElapsed = endCounter - startCounter;
      // check if the HX711 did not turn off:
      // if pd_sck pin is HIGH for 60 us and more than the HX 711 enters power down mode.
      if (timeElapsed >= 60) {
        console.log(
          `Reading data took longer than 60µs. Time elapsed: ${timeElapsed}`
        );
        return this.__setChannelGain(channelGain, true);
      }
    }
    return true;
  }

  /**
   *
   * @returns boolean
   * @private
   */
  __isReady() {
    return this.__dataPin.digitalRead() === 0;
  }

  /**
   *
   * @returns {boolean}
   */
  tare() {
    this.__offset = -1 * this.__readRawAverage(10);
    return true;
  }

  /**
   *
   * @param rawValue
   * @returns {number}
   * @private
   */
  __applyNormalisation(rawValue) {
    return (rawValue + this.__offset) / this.__scale;
  }

  calibrateScale(knownWeight) {
    this.__scale = (this.__readRawAverage(5) + this.__offset) / knownWeight;
    return this.__scale;
  }

  readAverage(numberOfTimes) {
    this.latestReading = this.__applyNormalisation(
      this.__readRawAverage(numberOfTimes)
    );
    return this.latestReading;
  }

  /**
   *
   * @param numberOfTimes
   * @returns {number}
   */
  __readRawAverage(numberOfTimes) {
    numberOfTimes = numberOfTimes < 0 ? 1 : numberOfTimes;
    let sum = 0;
    for (let i = 0; i < numberOfTimes; i++) {
      let result = false;
      while (result === false) {
        result = this.__readRaw();
      }
      sum += result;
    }
    return sum / numberOfTimes;
  }

  read() {
    return this.readAverage(1);
  }

  /**
   *
   * @returns {number | boolean}
   */
  __readRaw() {
    const maxAttempts = 9999;

    // start by setting the pd_sck to false
    this.__clockPin.digitalWrite(0);
    // init the counter
    let attemptsCounter = 0;

    // loop until HX711 is ready
    // halt when maximum number of tries is reached
    for (let attemptsCounter = 0; !this.__isReady(); attemptsCounter++) {
      sleep.msleep(1);
      if (attemptsCounter >= maxAttempts) {
        // console.log('Exceeded max attempts, Hx711 is not ready yet');
        return false;
      }
    }

    // Note that in JS, every number is a 64bit float
    let data_in = 0x000000; // 2's complement data from hx 711

    // read first 24 bits of data
    for (let i = 0; i < 24; i++) {
      // start timer
      const startCounter = microtime.now();
      // request next bit from HX711
      this.__clockPin.digitalWrite(1);
      this.__clockPin.digitalWrite(0);
      // stop timer
      const endCounter = microtime.now();
      const timeElapsed = endCounter - startCounter;
      // check if the hx 711 did not turn off:
      // if pd_sck pin is HIGH for 60 us and more than the HX 711 enters power down mode.
      if (timeElapsed >= 60) {
        console.log(
          `Reading data took longer than 60µs. Time elapsed: ${timeElapsed}`
        );
        return false;
      }

      // Shift the bits as they come to data_in variable.
      // Left shift by one bit then bitwise OR with the new bit.
      data_in = (data_in << 1) | this.__dataPin.digitalRead();
      // console.log(`Binary value as it has come: ${data_in.toString(2)} bit${i}`);
    }
    this.__setChannelGain(this.__channelGain, false);

    sleep.msleep(1);

    // check if data is valid
    // 0x800000 and 0x7fffff are emitted from HX711 when data is out of range
    if (data_in === 0x7fffff || data_in === 0x800000) {
      console.log("Invalid data detected: " + data_in);
      return false;
    }

    // calculate int from 2's complement
    let signed_data = 0x000000;
    if (data_in & 0x800000) {
      // 0b1000 0000 0000 0000 0000 0000 check if the sign bit is 1. Negative number.
      signed_data = -1 * ((data_in ^ 0xffffff) + 1); // convert from 2's complement to int
    } else {
      // else do not do anything the value is positive number
      signed_data = data_in;
    }
    // console.log('Converted 2\'s complement value: ' + (signed_data));
    return signed_data;
  }
}

/**
 * Static enums
 */
HX711.CHANNEL_A_GAIN_128 = {};
HX711.CHANNEL_B_GAIN_32 = {};
HX711.CHANNEL_A_GAIN_64 = {};

module.exports = HX711;
