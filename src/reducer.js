import { combineReducers } from 'redux';
import { ReducerHelpers as RH } from '@towercg/server';

export const pluginReducer = RH.keyedSetter("timers.setTimerData", "timers.deleteTimer");
