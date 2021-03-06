
var log4js = require('log4js');
var conv = require('./hexconv');
var fs = require('fs');


log4js.configure({
  appenders: {
    everything: { type: 'file', filename: 'debug.log' }
  },
  categories: {
    default: { appenders: [ 'everything' ], level: 'debug' }
  }
});

const logger = log4js.getLogger();
logger.level = 'debug';

// Data model:
//
// Each value (volt, current, power, state of charge...) owns a register
// on the device. All registers are cached in this application's objects
// that also provide conversions, formatters, units, callbacks on change,
// descriptions etc.
// Some of these register values are bundled into a package and send
// every 1 second (1-second-updates). Among them are the history values
// (H1, H2, ...) and the most important values like voltage, current,
// power, state of charge.
//
// For convenience there are 3 maps pointing to the same objects:
//
// addressCache: maps addresses of device registers to objects,
//               e.g. the voltage 'V' is stored in register
//                    at address 0xED8D. When reading the value
//                    directly from the register it needs to be
//                    multiplied by 10 to get millivolts.
// bmvdata:      maps human readable names to the same objects,
//               e.g. 'V' is the upper voltage, hence bmvdata.upperVoltage
// map:          maps the keys of the 1-second-updates to the same objects

// bmvdata maps human readable keys to objects
var bmvdata = {};
// map's keys correspond to the keys used in the frequent 1-second-updates
var map = {}
// addressCache's keys map the register's addresses to the objects
var addressCache = {};

function formatSeconds(duration) {
    if (duration == -1 || duration === undefined || duration === null) return "infinite";

    var base    = 60;
    // duration in seconds
    var seconds = duration % base;
    duration    = Math.floor(duration / base); // in minutes
    var minutes = duration % base;
    duration    = Math.floor(duration / base); // in hours
    base = 24;
    var hours   = duration % base;
    duration    = Math.floor(duration / base); // in days
    base = 7;
    var days    = duration % base;
    duration    = Math.floor(duration / base); // in weeks
    var weeks   = duration;

    var weekStr = (weeks > 0) ? weeks + ((weeks == 1) ? " week" : " weeks") : "";
    var dayStr  = (days  > 0) ? days  + ((days  == 1) ? " day"  : " days")  : "";
    hours = (hours < 10) ? "0" + hours : hours;
    minutes = (minutes < 10) ? "0" + minutes : minutes;
    seconds = (seconds < 10) ? "0" + seconds : seconds;

    return weekStr + " " + dayStr + " " + hours + "h " + minutes + "m " + seconds + "s";
}

var getProductLongname = function(pid) {
    if (pid == "0x203" ) return("BMV-700");
    if (pid == "0x204" ) return("BMV-702");
    if (pid == "0x205" ) return("BMV-700H");
    if (pid == "0xA381") return("BMV-712");
    if (pid == "0x300" ) return("BlueSolar MPPT 70/15");        // model phased out
    if (pid == "0xA04C") return("BlueSolar MPPT 75/10");
    if (pid == "0xA042") return("BlueSolar MPPT 75/15");
    if (pid == "0xA040") return("BlueSolar MPPT 75/50");        // model phased out
    if (pid == "0xA043") return("BlueSolar MPPT 100/15");
    if (pid == "0xA044") return("BlueSolar MPPT 100/30");       // model phased out
    if (pid == "0xA04A") return("BlueSolar MPPT 100/30 rev 2");
    if (pid == "0xA045") return("BlueSolar MPPT 100/50 rev 1"); // model phased out
    if (pid == "0xA049") return("BlueSolar MPPT 100/50 rev 2");
    if (pid == "0xA041") return("BlueSolar MPPT 150/35 rev 1"); // model phased out
    if (pid == "0xA04B") return("BlueSolar MPPT 150/35 rev 2");
    if (pid == "0xA04D") return("BlueSolar MPPT 150/45");
    if (pid == "0xA04E") return("BlueSolar MPPT 150/60");
    if (pid == "0xA046") return("BlueSolar MPPT 150/70");
    if (pid == "0xA04F") return("BlueSolar MPPT 150/85");
    if (pid == "0xA047") return("BlueSolar MPPT 150/100");
    if (pid == "0xA051") return("SmartSolar MPPT 150/100");
    if (pid == "0xA050") return("SmartSolar MPPT 250/100");
    if (pid == "0xA201") return("Phoenix Inverter 12V 250VA 230V");
    if (pid == "0xA202") return("Phoenix Inverter 24V 250VA 230V");
    if (pid == "0xA204") return("Phoenix Inverter 48V 250VA 230V");
    if (pid == "0xA211") return("Phoenix Inverter 12V 375VA 230V");
    if (pid == "0xA212") return("Phoenix Inverter 24V 375VA 230V");
    if (pid == "0xA214") return("Phoenix Inverter 48V 375VA 230V");
    if (pid == "0xA221") return("Phoenix Inverter 12V 500VA 230V");
    if (pid == "0xA222") return("Phoenix Inverter 24V 500VA 230V");
    if (pid == "0xA224") return("Phoenix Inverter 48V 500VA 230V");
    if (pid) logger.warn("getProductLongname: Unknown product: " + pid);
    return ("Unknown");
};

var getAlarmText = function(alarmcode) {
    // BMV alarms + Phoenix Inverter alarms
    if (alarmcode & 0x0001) return("Low voltage");
    if (alarmcode & 0x0002) return("High voltage");
    if (alarmcode & 0x0020) return("Low temperature");
    if (alarmcode & 0x0040) return("High temperature");
    // BMV (only) alarms
    if (alarmcode & 0x0004) return("Low state of charge (SOC)");
    if (alarmcode & 0x0008) return("Low starter voltage");
    if (alarmcode & 0x0010) return("High starter voltage");
    if (alarmcode & 0x0080) return("Mid voltage");
    // Phoenix Inverter alarms
    if (alarmcode & 0x0100) return("Overload");
    if (alarmcode & 0x0200) return("DC-ripple");
    if (alarmcode & 0x0400) return("Low V AC out");
    if (alarmcode & 0x0800) return("High V AC out");
    if (alarmcode > 0x0FFF) logger.warn("getAlarmText: Unknown alarm code: " + alarmcode);
    return("no alarm");
};

var getStateOfOperationText = function(state) {
    // State of operation
    switch(state) {
    case    '0': // applies to MPPT and Inverter
        return("OFF");
    case    '1': // applies to Inverter
        return("Low power"); // load search
    case    '2': // applies to MPPT and Inverter
        return("Fault"); // off until user reset
    case    '3': // applies to MPPT
        return("Bulk");
    case    '4': // applies to MPPT
        return("Absorption");
    case    '5': // applies to MPPT
        return("Float");
    case    '9': // applies to Inverter
        return("Inverting"); // on
    }
    logger.warn("getStateOfOperationText: Unknown charge state: " + state);
    return("unknown");
};

var getDeviceModeText = function(mode) {
    switch(mode) {
    case    '2':
        return("Inverter");
    case    '4':
        return("Off");
    case    '5':
        return("Eco");
    }
    logger.warn("getDeviceModeText: Unknown mode: " + mode);
    return("unknown");
};

var getErrorText = function(errorCode) {
    switch(errorCode) {
    case    '0':
        return("No error");
    case    '2':
        return("Battery voltage too high");
    case    '17':
        return("Charger temperature too high");
    case    '18':
        return("Charger over current");
    case    '19': // can be ingored; regularly occurs during start-up or shutdown
        return("Charger current reversed");
    case    '20':
        return("Bulk time limit exceeded");
    case    '21': // can be ignored for 5 minutes; regularly occurs during start-up or shutdown
        return("Current sensor issue (sensor bias/sensor broken)");
    case    '26':
        return("Terminals overheated");
    case    '33':
        return("Input voltage too high (solar panel)");
    case    '34':
        return("Input current too high (solar panel)");
    case    '38':
        return("Input shutdown (due to excessive battery voltage)");
    case    '116':
        return("Factory calibration data lost");
    case    '117':
        return("Invalid/incompatible firmware");
    case    '119':
        return("User settings invalid");
    }
    logger.warn("getErrorText: Unknown error code: " + errorCode);
    return("unknown");
};

// nativeToUnitFactor == 0 ==> output: unformatted value without units,
//                             e.g. use for strings
// nativeToUnitFactor: value[in units] = nativeToUnitFactor * raw value
// units == "" for unit-less values
// units == "s" ==> output in format weeks days h m s;
//                  \pre nativeToUnitFactor must convert to seconds
function register(key, nativeToUnitFactor, units, shortDescr, options) {
    if (map[key] === undefined)
    {
	map[key] = new Object();
	logger.debug("Creating new object for " + key);
    };
    map[key].value = null; // FIXME: use undefined rather than null
    map[key].newValue = null;
    // choose 0 for strings
    map[key].nativeToUnitFactor = nativeToUnitFactor;
    // e.g. A, V, km/h, % ...
    map[key].units = units;
    map[key].shortDescr = shortDescr;
    // format and scale from raw value to unit-value with given precision
    map[key].formatted = function() {
	if (this.nativeToUnitFactor === 0) return this.value;
	var scaledToIntPrecision = Number(this.value * this.nativeToUnitFactor / this.precision);
	var div = 1 / this.precision;
	// TODO: use toFixed  
	//return scaledToIntPrecision.toFixed(2);
	return Math.floor(scaledToIntPrecision) / div;
    }
    map[key].formattedWithUnit = function() {
	if (this.units === "s")
	{
	    // nativeToSIFactor must convert the value to SI i.e. seconds
	    var timeInSecs = Math.round(this.value * this.nativeToUnitFactor);
	    var durationStr = "infinity";
	    if (timeInSecs >= 0) durationStr = formatSeconds(timeInSecs);
	    return durationStr;
	}
	else if (this.nativeToUnitFactor === 0) return this.value;
	else return this.formatted() + " " + this.units;
    }
    // initialize defaults for optional parameters:
    map[key].description = ""; // default
    map[key].precision = 0.01; // default precision -2 digits after dot
    // TODO: map[key].on = []; and implement addListener, deleteListener
    map[key].on = null;
    // if values are read from register instead of the frequent value
    // updates, the values are in hexadecimal string format and may
    // have a different factor that needs to be applied to convert
    // to the same value as the frequent update. This is done by
    // fromHexStr and the inverse function by toHexStr
    map[key].fromHexStr = conv.hexToUint; // default
    map[key].toHexStr = null;
    // if options exist, overwrite specific option:
    if (options === undefined) return map[key];
    if (options['description'])
    {
	map[key].description = options['description'];
    }
    // example: pure int ==> precision := 0; 
    // 2 digits at the right of the decimal point ==> precision := -2
    if (options['precision'])
    {
	map[key].precision = Math.pow(10, options['precision']);
    }
    if (options['formatter'])
    {
	map[key].formatted = options['formatter'];
    }
    if (options['on'])
    {
	map[key].on = options['on'];
    }
    if (options['fromHexStr'])
    {
	map[key].fromHexStr = options['fromHexStr'];
    }
    if (options['toHexStr'])
    {
	map[key].toHexStr = options['toHexStr'];
    }
    return map[key];
};



function map_components() {
    logger.trace("Registering");
    // component:  your given name
    // key:        string identifier that comes with the value sent by BMV
    // n2UF:       nativeToUnitFactor (output value = n2UF * BMV_value)
    // units:      Ampere, Volts etc. the units must fit the n2UF 
    // shortDescr: used as label for the value
    // options:    list of key values, known keys: precision, description, formatter
    //             precision: negative: -n; round to n digits right to the decimal separator
    //                        zero:      0; round to integer
    //                        positive: +n; round to the n-th digit left from decimal separator
    //                        default:  -2; round to 2 digits right to the decimal separator
    //      component,                      key     n2UF,  units,  shortDescr,     options

    // Monitored values:
    // BMV600, BMV700, Phoenix Inverter
    bmvdata.alarmReason         = register('AR',    1,      "",    "Alarm reason",
					   {'precision': 0, 'formatter' : function() 
    {
	return getAlarmText(this.value);
    }});

    // BMV600, BMV700, MPPT - Type Sn16; Unit: 0.1A!!!
    // On BMV-712 >v4.01 and BMV-70x >v3.09: Type: Sn32; Unit: 0.001A
    bmvdata.batteryCurrent      = register('I',     0.001,  "A",   "Battery Current",
					   {'fromHexStr': function(hex) { return 100 * conv.hexToSint(hex); } });
    addressCache['0xED8F']      = bmvdata.batteryCurrent;
    // only on BMV-712 > v4.01 and BMV-70x > v3.09: is might be address '0xED8C'

    // MPPT
    bmvdata.loadCurrent         = register('IL',    0.001,  "A",   "Load Current");
    // MPPT - returns string 'ON' or 'OFF'
    bmvdata.load                = register('LOAD',  0,      "",    "Load Output State",
					   { 'fromHexStr': function(hex) 
                                                           { 
 							       if (conv.hexToInt(hex) == 0)
								   return 'OFF';
							       else return 'ON';
                                                           } });


    // BMV600, BMV700, MPPT, Phoenix Inverter - Display: MAIN; Type: Sn16; Unit: 0.01V!!!
    bmvdata.upperVoltage        = register('V',     0.001,  "V",   "Main Voltage",
					   { 'description': "Main (Battery) Voltage",
					     'fromHexStr': function(hex) { return 10 * conv.hexToSint(hex); }});
    addressCache['0xED8D']      = bmvdata.upperVoltage;

    // BMV700 - Display: MID; Type: Un16; Units: 0.01V!!! (only BMV-702 and BMV-712)
    bmvdata.midVoltage          = register('VM',    0.001,  "V",   "Mid Voltage",
					   { 'description': "Mid-point Voltage of the Battery Bank",
					     'fromHexStr': function(hex) { return 10 * conv.hexToSint(hex); }});
    // only on BMV-702 and BMV-712
    addressCache['0x0382']      = bmvdata.midVoltage;

    // BMV700 - Type: Un16; Unit: 0.01 K!!!
    bmvdata.batteryTemp         = register('T',     1.0,    "°C",  "Battery Temperature");
    // only on BMV-702 and BMV-712
    addressCache['0xEDEC']      = bmvdata.batteryTemp;

    // BMV700 - Type: Sn16; Unit: W
    bmvdata.instantPower        = register('P',     1.0,    "W",   "Instantaneous Power",
					   {'fromHexStr': conv.hexToSint });
    addressCache['0xED8E']      = bmvdata.instantPower;

    // BMV600, BMV700 - Type: Un16; Unit: 0.01%!!! for 0x0FFF
    //                  Type: Un8 for 0xEEB6 ??? (Synchronisation State)
    bmvdata.stateOfCharge       = register('SOC',   0.1,    "%",   "State of charge",
					   { 'precision': -1,
					     'fromHexStr' : function(hex) { return 0.1 * conv.hexToUint(hex); } });
    addressCache['0x0FFF']     = bmvdata.stateOfCharge; // tested 
    //addressCache['0xEEB6']     = bmvdata.stateOfCharge; // FIXME: what is this really?

    // BMV600, BMV700 - Display: AUX; Type: Sn16; Unit: 0.01V!!! (not available on BMV-702 and BMV-712)
    bmvdata.auxVolt             = register('VS',    0.001,  "V",   "Aux. Voltage",
					   { 'precision': -1, 'description': "Auxiliary (starter) Voltage",
					     'fromHexStr': function(hex) { return 10 * conv.hexToSint(hex); }});
    // only on BMV-702 and BMV-712
    addressCache['0xED7D']      = bmvdata.auxVolt;

    // BMV600, BMV700 - Type: Sn32; Unit: 0.1 Ah!!!
    bmvdata.consumedAh          = register('CE',    0.001,  "Ah",  "Consumed",
					   { 'description': "Consumed Ampere Hours",
					     'fromHexStr': function(hex) { return 100 * conv.hexToSint(hex); } });
    addressCache['0xEEFF']      = bmvdata.consumedAh;

    // BMV700 - Display: MID; Type: Sn16; Units: 0.1 %
    bmvdata.midDeviation        = register('DM',    1.0,    "%",   "Mid Deviation",
					   { 'description': "Mid-point Deviation of the Battery Bank",
					     'fromHexStr' : conv.hexToSint });
    // only on BMV-702 and BMV-712
    addressCache['0x0383']      = bmvdata.midDeviation;

    // MPPT
    bmvdata.panelVoltage        = register('VPV',   0.001,  "V",   "Panel Voltage");
    // MPPT
    bmvdata.panelPower          = register('PPV',   1.0,    "W",   "Panel Power");
    // MPPT, Phoenix Inverter
    bmvdata.stateOfOperation    = register('CS',    0,      "",    "State of Operation", {'formatter' : function() 
    {
	return getStateOfOperationText(this.value);
    }});
    // BMV700, MPPT, Phoenix Inverter
    bmvdata.productId           = register('PID',   0,      "",    "Product ID", {'formatter' : function() 
    {
	return getProductLongname(this.value);
    }});
    // BMV600, BMV700, MPPT, Phoenix Inverter
    bmvdata.version             = register('FW',    0.01,  "",     "Firmware version");

    // History values
    // BMV600, BMV700
    bmvdata.deepestDischarge    = register('H1',    0.001, "Ah",   "Deepest Discharge",
					   { 'precision': -2, 'description': "Depth of deepest discharge",
					     'fromHexStr' : function(hex) { return 100 * conv.hexToSint(hex); } });
    addressCache['0x0300']      = bmvdata.deepestDischarge;

    // BMV600, BMV700
    bmvdata.maxAHsinceLastSync  = register('H2',    0.001, "Ah",   "Last Discharge",
					   { 'precision': 0, 'description': "Depth of last discharge", // Max Discharge since sync
					     'fromHexStr': function(hex) { return 100 * conv.hexToSint(hex); } });
    addressCache['0x0301']      = bmvdata.maxAHsinceLastSync;

    // BMV600, BMV700
    bmvdata.avgDischarge        = register('H3',    0.001, "Ah",   "Avg. Discharge",
					   { 'description': "Depth of average discharge",
					     'fromHexStr' : function(hex) { return 100 * conv.hexToSint(hex); }});
    addressCache['0x0302']      = bmvdata.avgDischarge;

    // BMV600, BMV700
    bmvdata.chargeCycles        = register('H4',    1.0,   "",     "Charge Cycles",
					   { 'description': "Number of charge cycles" });
    addressCache['0x0303']      = bmvdata.chargeCycles;

    // BMV600, BMV700
    bmvdata.fullDischarges      = register('H5',    1.0,   "",     "Full Discharges",
					   { 'description': "Number of full discharges" });
    addressCache['0x0304']      = bmvdata.fullDischarges;

    // BMV600, BMV700
    bmvdata.drawnAh             = register('H6',    0.001, "Ah",   "Cum. Ah drawn",
					   { 'fromHexStr': function(hex) { return 100 * conv.hexToSint(hex); }});
    addressCache['0x0305']      = bmvdata.drawnAh;

    // BMV600, BMV700
    bmvdata.minVoltage          = register('H7',    0.001, "V",    "Min. Voltage",
					   { 'description': "Minimum Main (Battery) Voltage",
					     'fromHexStr': function(hex) { return 10 * conv.hexToSint(hex); }});
    addressCache['0x0306']      = bmvdata.minVoltage;

    // BMV600, BMV700
    bmvdata.maxVoltage          = register('H8',    0.001, "V",    "Max. Voltage",
					   { 'description': "Maximum Main (Battery) Voltage",
					     'fromHexStr': function(hex) { return 10 * conv.hexToSint(hex); }});
    addressCache['0x0307']      = bmvdata.maxVoltage;

    // BMV600, BMV700
    bmvdata.timeSinceFullCharge = register('H9',    1.0,   "s",    "Time since Full Charge",
					   { 'description': "Number of seconds since full charge" });
    addressCache['0x0308']      = bmvdata.timeSinceFullCharge;

    // BMV600, BMV700
    bmvdata.noAutoSyncs         = register('H10',   1,     "",     "Auto. Syncs",
					   { 'description': "Number of automatic synchronisations" });
    addressCache['0x0309']     =  bmvdata.noAutoSyncs;

    // BMV600, BMV700
    bmvdata.lowVoltageAlarms    = register('H11',   1,     "",     "Low Volt. Alarms",
					   { 'description': "Number of Low Main Voltage Alarms" });
    addressCache['0x030A']      = bmvdata.lowVoltageAlarms;

    // BMV600, BMV700
    bmvdata.highVoltageAlarms   = register('H12',   1,     "",     "High Volt. Alarms",
					   { 'description': "Number of High Main Voltage Alarms" });
    addressCache['0x030B']      = bmvdata.highVoltageAlarms;

    // BMV600
    bmvdata.lowAuxVoltageAlarms = register('H13',   1,     "",     "Low Aux. Volt. Alarms",
					   { 'description': "Number of Low Auxiliary Voltage Alarms" });

    // BMV600
    bmvdata.highAuxVoltageAlarms= register('H14',   1,     "",     "High Aux. Volt. Alarms",
					   { 'description': "Number of High Aux. Voltage Alarms" });
    // BMV600, BMV700
    bmvdata.minAuxVoltage       = register('H15',   0.001, "V",    "Min. Aux. Volt.",
					   { 'description': "Minimal Auxiliary (Battery) Voltage",
					     'fromHexStr': function(hex) { return 10 * conv.hexToSint(hex); }});
    addressCache['0x030E']      = bmvdata.minAuxVoltage;

    // BMV600, BMV700
    bmvdata.maxAuxVoltage       = register('H16',   0.001, "V",    "Max. Aux. Volt.",
					   { 'description': "Maximal Auxiliary (Battery) Voltage",
					     'fromHexStr': function(hex) { return 10 * conv.hexToSint(hex); }});
    addressCache['0x030F']      = bmvdata.maxAuxVoltage;

    // BMV700
    bmvdata.dischargeEnergy     = register('H17',   0.01,  "kWh",  "Drawn Energy",
					   { 'description': "Amount of Discharged Energy" });
    addressCache['0x0310']      = bmvdata.dischargeEnergy;

    // BMV700
    bmvdata.absorbedEnergy      = register('H18',   0.01,  "kWh",  "Absorbed Energy",
					   { 'description': "Amount of Charged Energy" });
    addressCache['0x0311']      = bmvdata.absorbedEnergy;

    // MPPT
    bmvdata.yieldTotal          = register('H19',   0.01,  "kWh",  "Yield Total",
					   { 'description': "User resettable counter" });
    // MPPT
    bmvdata.yieldToday          = register('H20',   0.01,  "kWh",  "Yield Today");
    // MPPT
    bmvdata.maxPowerToday       = register('H21',   1.0,   "W",    "Max. Power Today");
    // MPPT
    bmvdata.yieldYesterday      = register('H22',   0.01,  "kWh",  "Yield Yesterday");
    // MPPT
    bmvdata.maxPowerYesterday   = register('H23',   1.0,   "W",    "Max. Power Yesterday");
    // MPPT
    bmvdata.errorCode           = register('ERR',   1,     "",     "MPPT Error Code", {'formatter' : function() 
    {
	return getErrorText(this.value);
    }});
    // Phoenix Inverter
    bmvdata.warnReason          = register('WARN',  0,     "",     "Warning Reason");
    // MPPT, Phoenix Inverter
    bmvdata.serialNumber        = register('SER#',  0,     "",     "Serial Number");
    // BlueSolar MPPT - returns 0..364
    bmvdata.daySequenceNumber   = register('HSDS',  1,     "",     "Day Sequence Number");
    // Phoenix Inverter
    bmvdata.deviceMode          = register('MODE',  1,     "",     "Device Mode", {'formatter' : function() 
    {
	return getDeviceModeText(this.value);
    }});

    // Phoenix Inverter
    bmvdata.ACoutVoltage        = register('AC_OUT_V',0.01,"V",    "AC Output Voltage");
    // Phoenix Inverter
    bmvdata.ACoutCurrent        = register('AC_OUT_I',0.1, "A",    "AC Output Current");

    // BMV600, BMV700 - Type: Un16; Units: minutes
    bmvdata.timeToGo            = register('TTG',   60.0,  "s",    "Time to go",
					   {'description': "Time until discharged" });
    addressCache['0x0FFE']      = bmvdata.timeToGo;

    // BMV600, BMV700 - returns string 'ON' or 'OFF'
    bmvdata.alarmState          = register('Alarm', 0,   "",       "Alarm state",
					   {'description': "Alarm condition active",
					    'fromHexStr':  function(hex) 
                                                           { 
 							       if (conv.hexToInt(hex) == 0)
								   return 'OFF';
							       else return 'ON';
                                                           } });

    addressCache['0xEEFC']      = bmvdata.alarmReason;

    // BMV600, BMV700, SmartSolar MPPT - returns string 'ON' or 'OFF'
    bmvdata.relayState          = register('Relay', 0,   "",       "Relay state",
					   { 'fromHexStr': function(hex) 
                                                           { 
 							       if (conv.hexToInt(hex) == 0)
								   return 'OFF';
							       else return 'ON';
                                                           } });

    // FIXME: how does this value behave with the inversion of the relay?
    addressCache['0x034E']      = bmvdata.relayState;

    // BMV600, BMV700
    bmvdata.modelDescription    = register('BMV',   0,   "",       "Model Description");

    // FIXME: the following keys 'Cap', 'CV', 'TC' etc do not exist in the
    //        fequentu updates...
    // TODO:  change register function without creating a key then
    //        do the map-ping outside register...
    // Battery settings: all of Type Un16 except UserCurrentZero
    bmvdata.capacity            = register('Cap',   1,   "Ah",     "Battery capacity");
    addressCache['0x1000']      = bmvdata.capacity;

    bmvdata.chargedVoltage      = register('CV',  0.1,   "V",      "Charged voltage");
    addressCache['0x1001']      = bmvdata.chargedVoltage;

    bmvdata.tailCurrent         = register('TC',  0.1,   "%",      "Tail current");
    addressCache['0x1002']      = bmvdata.tailCurrent;

    bmvdata.chargedDetectTime   = register('CDT',   1,   "min",    "Charged detection time");
    addressCache['0x1003']      = bmvdata.chargedDetectTime;

    bmvdata.chargeEfficiency    = register('CEFF',  1,   "%",      "Charge efficiency");
    addressCache['0x1004']      = bmvdata.chargeEfficiency;

    bmvdata.peukertCoefficient  = register('PC', 0.01,   "",      "Peukert coefficiency");
    addressCache['0x1005']      = bmvdata.peukertCoefficient;

    bmvdata.currentThreshold    = register('CT', 0.01,    "A",     "Current threshold");
    addressCache['0x1006']      = bmvdata.currentThreshold;

    bmvdata.timeToGoDelta       = register('TTGD',  1,    "min",   "Time to go Delta T");
    addressCache['0x1007']      = bmvdata.timeToGoDelta;

    bmvdata.relayLowSOC         = register('RSOC', 0.1,    "%",     "Relay low SOC");
    addressCache['0x1008']      = bmvdata.relayLowSOC;

    bmvdata.relayLowSOCClear    = register('RSOC_Clear', 0.1,"%",    "Relay low SOC clear");

    // UCZ is of Type: Sn16; Read-Only
    addressCache['0x1009']      = bmvdata.relayLowSOCClear;

    bmvdata.userCurrentZero     = register('UCZ',   1,    "",      "User current zero",
					   { 'fromHexStr': conv.hexToInt });
    addressCache['0x1034']      = bmvdata.userCurrentZero;

    // Additional declarations:
    bmvdata.topVoltage          = register('Vtop',  0.001,  "V", "Top Voltage", {'formatter' : function() 
    {
      this.value = bmvdata.upperVoltage.value - bmvdata.midVoltage.value;
      if (this.nativeToUnitFactor === 0) return this.value;
      var scaledToIntPrecision = Number(this.value * this.nativeToUnitFactor / this.precision);
      var div = 1 / this.precision;
      return Math.floor(scaledToIntPrecision) / div;
    }
    });

    // bmvdata.topSOC          = register('SOCtop',  1,  "%", "Top SOC", {'formatter' : function() 
    // {
    // 	var topSOC    = estimate_SOC(bmvdata.topVoltage.formatted());
    // 	topSOC = Math.round(topSOC * 100) / 100;
    // 	return topSOC;
    // }});
    // bmvdata.bottomSOC      = register('SOCbot',  1,  "%", "Bottom SOC", {'formatter' : function() 
    // {
    // 	var bottomSOC = estimate_SOC(bmvdata.midVoltage.formatted());
    // 	bottomSOC = Math.round(bottomSOC * 100) / 100;
    // 	return bottomSOC;
    // }});
};

map_components();

exports.bmvdata = bmvdata;
exports.map = map;
exports.addressCache = addressCache;
