import * as TowerCGServer from '@towercg/server';

import autobind from 'auto-bind';
import * as _ from 'lodash';
import juration from 'juration';

import { pluginReducer } from './reducer';

// {
//   name: "myTimer",
//   type: "incrementing",
//
//   running: true,
//   elapsed: false,
//
//   timestamp: 1505799882616, // new Date().getTime()
//
//   value: 5000,
//   duration: 13336006, // (juration.parse("3h 42m 16s 6ms") * 1000)
// }

// TODO: add splits to incrementing timers

// TODO: could probably add revivers to actually make timers object-oriented
//       (but can we then safely store/persist them through Redux?)
const timerFunctions = {
  incrementing: (timer) => {
    const newTimer = _.cloneDeep(timer);
    newTimer.timestamp = new Date().getTime();
    const gap = newTimer.timestamp - timer.timestamp;

    newTimer.value += gap;

    newTimer.elapsed = newTimer.value > newTimer.duration;

    return newTimer;
  },
  decrementing: (timer) => {
    const newTimer = _.cloneDeep(timer);
    newTimer.timestamp = new Date().getTime();
    const gap = newTimer.timestamp - timer.timestamp;

    newTimer.value -= gap;

    newTimer.elapsed = newTimer.value < 0;

    return newTimer;
  }
}

const timerResetFunctions = {
  incrementing: (timer) => _.merge({}, timer, { value: 0 }),
  decrementing: (timer) => _.merge({}, timer, { value: timer.duration })
}

export class TimersPlugin extends TowerCGServer.ServerPlugin {
  static pluginName = "timers";
  static reducer = pluginReducer;
  static defaultConfig = { tickRate: 96 };

  constructor(pluginConfig, server) {
    super(pluginConfig, server);
    autobind(this);
  }

  async initialize() {
    const tickRate = this.pluginConfig.tickRate;

    this.logger.info(`Initializing timer system at ${tickRate}ms.`);
    this._registerCommands();

    setInterval(() => this._handleTimers(), tickRate);
  }

  _handleTimers() {
    const timers = this.state;

    for (let timer of Object.values(timers)) {
      if (!timer.running) continue;

      const timerFunction = timerFunctions[timer.type];

      if (!timerFunction) {
        this.logger.warn(`Timer '${timer.name} has an unrecognized type: ${timer.type}'.`);
      } else {
        const newTimer = timerFunction(timer);
        this.dispatch({ type: "timers.setTimerData", key: newTimer.name, payload: newTimer });

        if (newTimer.elapsed && !timer.elapsed) {
          this.emit("timerElapsed", newTimer)
        }
      }
    }
  }

  _registerCommands() {
    this.registerCommand('createTimer', (payload) => this._createTimer(payload.name, payload.type, payload.duration));
    this.registerCommand('deleteTimer', (payload) => this._deleteTimer(payload.name));
    this.registerCommand('resetTimer', (payload) => this._resetTimer(payload.name, payload.pause));
    this.registerCommand('pauseTimer', (payload) => this._pauseTimer(payload.name));
    this.registerCommand('resumeTimer', (payload) => this._resumeTimer(payload.name));
    this.registerCommand('toggleTimer', (payload) => this._toggleTimer(payload.name));
  }

  _withTimer(timerName, cb) {
    const timers = this.state;
    const timer = timers[timerName];

    if (!timer) {
      throw new Error(`Timer '${timerName}' not found.`);
    }

    return cb(timer);
  }

  _createTimer(timerName, type, duration) {
    if (this.timers[timerName]) {
      throw new Error(`Timer '${timerName}' already exists.`);
    }

    switch (typeof(duration)) {
      case "string":
        const parsed = juration.parse(duration) * 1000;
        this.logger.debug(`Juration: '${duration}' parsed to ${parsed}ms.`);
        duration = parsed;
        break;
      case "number":
        break;
      default:
        throw new Error(`Invalid duration type: ${typeof(duration)}`);
    }

    const timerFunction = timerFunctions[type];
    const timerResetFunction = timerResetFunctions[type];
    if (!timerFunction) {
      throw new Error(`Timer '${timerName}' can't be created with nonexistent type '${type}'.`);
    }

    this.logger.info(`Creating timer '${timerName}'; type ${type}, duration ${duration}ms.`);

    const newTimer = timerResetFunction({
      name: timerName,
      type,
      duration,
      running: false,
      elapsed: false
    });

    this.dispatch({ type: "timers.setTimerData", key: newTimer.name, payload: newTimer });
    this.emit('timerCreated', newTimer);
    return newTimer;
  }

  _deleteTimer(timerName) {
    return this._withTimer(timerName, (timer) => {
      this.logger.info(`Deleting timer '${timer.name}'.`);
      this.dispatch({ type: "timers.deleteTimer", key: timer.name });

      this.emit('timerDeleted', { name: timerName });
      return { deleted: true };
    });
  }

  _resetTimer(timerName, pause = true) {
    return this._withTimer(timerName, (timer) => {
      this.logger.info(`Resetting timer '${timer.name}'.`);
      const newTimer = timerResetFunctions[timer.type](timer);

      newTimer.running = !pause;
      newTimer.elapsed = false;

      this.dispatch({ type: "timers.setTimerData", key: newTimer.name, payload: newTimer });
      this.emit('timerReset', newTimer);
      return newTimer;
    });
  }

  _pauseTimer(timerName) {
    return this._withTimer(timerName, (timer) => {
      if (!timer.running) {
        this.logger.warn(`Attempting to pause '${timer.name}', but already paused.`);
      } else {
        this.logger.info(`Pausing timer '${timer.name}'.`);
        const newTimer = _.cloneDeep(timer);
        newTimer.running = false;

        this.dispatch({ type: "timers.setTimerData", key: newTimer.name, payload: newTimer });
        this.emit('timerPaused', newTimer);
        return newTimer;
      }
    });
  }

  _resumeTimer(timerName) {
    return this._withTimer(timerName, (timer) => {
      if (timer.running) {
        this.logger.warn(`Attempting to resume '${timer.name}', but already running.`);
      } else {
        this.logger.info(`Resuming timer '${timer.name}'.`);
        const newTimer = _.cloneDeep(timer);
        newTimer.running = true;
        newTimer.timestamp = new Date().getTime();

        this.dispatch({ type: "timers.setTimerData", key: newTimer.name, payload: newTimer });
        this.emit('timerResumed', newTimer);
        return newTimer;
      }
    });
  }

  _toggleTimer(timerName) {
    return this._withTimer(timerName, (timer) => {
      const fn = timer.running ? this._pauseTimer : this._resumeTimer;

      // This is kind of gross, it does a double run through _withTimer, but we
      // have special logic in _resumeTimer, so it's fine for now.
      return fn(timerName);
    });
  }
}
