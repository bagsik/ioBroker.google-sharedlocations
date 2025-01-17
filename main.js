"use strict";

// you have to require the utils module and call adapter function
const utils = require('@iobroker/adapter-core'); // Get common adapter utils

// for communication
const request = require('request');

const min_polling_interval = 60; // minimum polling interval in seconds

const trigger_poll_state = 'trigger_poll';  // state for triggering a poll

// you have to call the adapter function and pass a options object
// name has to be set and has to be equal to adapters folder name and main file name excluding extension
// adapter will be restarted automatically every time as the configuration changed, e.g system.adapter.google-sharedlocations.0
const adapter = new utils.adapter('google-sharedlocations');

let google_polling_interval_id = null;
let google_cookie_header;

// triggered when the adapter is installed
adapter.on('install', function () {
  // create connection variable https://github.com/ioBroker/ioBroker/wiki/Adapter-Development-Documentation#infoconnection
});

// is called when the adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', function (callback) {
  try {
    callback();
  } catch (e) {
    callback(e);
  }
});

// is called if a subscribed object changes
adapter.on('objectChange', function (id, obj) {
  // Warning, obj can be null if it was deleted
  //adapter.log.debug('objectChange ' + id + ' ' + JSON.stringify(obj));
});

// is called if a subscribed state changes
adapter.on('stateChange', function (id, state) {

  if (state && !state.ack) {
    // a poll is triggered
    if (id && state && id === 'google-sharedlocations.' + adapter.instance + '.' + trigger_poll_state && state.val === true) {
      adapter.log.debug('Poll triggered by user.');
      triggerSingleQuery();
      adapter.setState(trigger_poll_state, false, false)
    }
  }
});

// is called when databases are connected and adapter received configuration.
// start here!
adapter.on('ready', function () {
  // start main function
  main();
});

// messages
adapter.on('message', function (obj) {
  let wait = false;
  let credentials;

  function DBUsersToSendTo(callback) {
    let ids = [];

    // get users
    adapter.getStates('google-sharedlocations.' + adapter.instance + '.user.*', function(err, states) {
      if(!err) {
        for (let cstate in states) {
          if (cstate.split('.')[cstate.split('.').length - 1] === 'id') {
            ids.push(cstate.split('.')[cstate.split('.').length - 2]);
          }
        }

        // get photo urls
        let res = [];
        for (let i = 0; i < ids.length; i++) {
          res.push({
            "id": ids[i],
            "photoURL": states['google-sharedlocations.' + adapter.instance + '.user.' + ids[i] + '.photoURL'].val,
            "name": states['google-sharedlocations.' + adapter.instance + '.user.' + ids[i] + '.name'].val
          });
        }

        callback(res);
      } else {
        callback(false);
      }
    });
  }


  if (obj) {
    switch (obj.command) {
      case 'checkConnection': {
        const cookie = obj.message.cookie;
        if (cookie) {
          google_cookie_header = cookie;
        }

        getSharedLocations((err) => {
          if (!err) {
            adapter.sendTo(obj.from, obj.command, true, obj.callback);
          } else {
            adapter.sendTo(obj.from, obj.command, false, obj.callback);
          }
        });
        wait = true;
        break;
      }
      case 'triggerPoll': {
        triggerSingleQuery(function (err) {
          adapter.sendTo(obj.from, obj.command, err, obj.callback);
        });
        wait = true;
        break;
      }
      case 'getUsers': {
        const cookie = obj.message.cookie;
        if (cookie) {
          google_cookie_header = cookie;
        }

        querySharedLocations(function (err) {
          if (!err) {
            DBUsersToSendTo(function (res) {
              adapter.sendTo(obj.from, obj.command, res, obj.callback);
            });
          } else {
            this.log.error('Error getting users: ' + err.stack);
            adapter.sendTo(obj.from.obj.command, [], obj.callback);
          }
        });
        wait = true;
        break;
      }
      case 'getUsersFromDB': {
        // get users
        DBUsersToSendTo(function (res) {
          adapter.sendTo(obj.from, obj.command, res, obj.callback);
        });
        wait = true;
        break;
      }
      default: {
        adapter.log.warn("Unknown command: " + obj.command);
        break;
      }
    }
  }
  if (!wait && obj.callback) {
    adapter.sendTo(obj.from, obj.command, obj.message, obj.callback);
  }

  return true;
});

// synchronize config
function syncConfig() {
  function stateInConfig(cstate) {
    let fences = adapter.config.fences;
    for(let j=0;j<fences.length;j++) {
      if('google-sharedlocations.' + adapter.instance + '.fence.' + fences[j].fenceid === cstate) {
        return true;
      }
    }
    return false;
  }

  function stateInDB(cstate, callback) {
    adapter.getStates('google-sharedlocations.' + adapter.instance + '.fence.*', function(err, states) {
      callback(states.hasOwnProperty(cstate));
    });
  }

  // check if there are states that have to be removed
  adapter.getStates('google-sharedlocations.' + adapter.instance + '.fence.*', function(err, states) {
    if (err) {
      adapter.log.error('SyncConfig: Could not retrieve states!');
    } else {
      for (let cstate in states) {
        if (!stateInConfig(cstate)) adapter.delObject(cstate);
      }
    }
  });

  let fences = adapter.config.fences;
  // create missing states
  for(let i=0;i<fences.length;i++) {
    stateInDB('google-sharedlocations.' + adapter.instance + '.fence.' + fences[i].fenceid, function(inDB) {
      if(!inDB) {
        // set all states to false at the beginning and create them if they do not exist
        setStateEx('fence.' + fences[i].fenceid, {
          common: {
            name: fences[i].description,
            desc: 'Fence for user ' + fences[i].userid,
            type: 'boolean',
            role: 'indicator',
            def: 'false',
            read: 'true',
            write: 'false'
          }
        }, false, true);
      }
    });
  }
}

// main function
function main() {
  // The adapters config (in the instance object everything under the attribute "native") is accessible via
  // adapter.config:
  adapter.log.info('Starting google shared locations adapter');

  // sync config
  syncConfig();

  // check polling interval
  if (Number(adapter.config.google_polling_interval) < min_polling_interval && Number(adapter.config.google_polling_interval) !== 0) {
    adapter.log.info('Configured poll interval of ' + adapter.config.google_polling_interval + 's smaller than minimum poll interval of ' + min_polling_interval + 's, will increase it to prevent 429 errors.');
    adapter.config.google_polling_interval = min_polling_interval;
  }

  if (Number(adapter.config.google_polling_interval) === 0) {
    // query locations is triggered only
    adapter.log.info('Polling disabled.');
  } else {
    // first connect and query
    // connect to Google
    adapter.log.debug('Polling location every ' + adapter.config.google_polling_interval + 's.');
    if(adapter.config.google_cookie) {
      google_cookie_header = adapter.config.google_cookie;
      triggerSingleQuery();
      // enable polling
      google_polling_interval_id = setInterval(function () {
        poll(function (err) {
        });
      }, Number(adapter.config.google_polling_interval) * 1000);
    }
  }
  // subscribe
  adapter.subscribeStates(trigger_poll_state);
  //adapter.subscribeStates('fence.*');
}

// issue a single query. If not connected, open a new connection
function triggerSingleQuery(callback) {
  querySharedLocations(function (err) {
    if (err) {
      adapter.log.error('An error occurred during polling the locations: ' + err.stack);
      adapter.setState('info.connection', false, true);
      if(callback) callback(err);
    } else {
      adapter.setState('info.connection', true, true);
      if(callback) callback(false);
    }
  });
}

// get locations
function querySharedLocations(callback) {
  getSharedLocations(function (err, userobjarr) {
    if (err) {
      //adapter.log.error('An error occurred during getSharedLocation! ' + err.stack);
      if (callback) callback(err)
    } else {
      // notify places adapter
      notifyPlaces(userobjarr, function(err) {
        if (err) {
          adapter.log.error('Error during places notification. ' + err.stack);
          if (callback) callback(err)
        }
      });

      // check fences
      checkFences(userobjarr, function (err) {
        if (err) {
          adapter.log.error('Error during fence check. ' + err.stack);
          if (callback) callback(err)
        } else {
          updateStates(userobjarr, function (err) {
            if (err) {
              if (callback) callback(err)
            } else {
              if (callback) callback(false)
            }
          });
        }
      });
    }
  });
}

// update states
function updateStates(userobjarr, callback) {
  if(userobjarr) {
    for(let i=0;i<userobjarr.length;i++) {
      // go through users
      for(let cprop in userobjarr[i]) {
        // we have a user, create the group
        let username = '';

        if (userobjarr[i].hasOwnProperty('name') && userobjarr[i]['name']) username = userobjarr[i]['name'];

        // let obj = {
        //     "_id": "user." + userobjarr[i].id,
        //     "type": "device",
        //     "common": {
        //     "name": username
        //   },
        //     "native": {}
        //   };
        // adapter.setObjectNotExists('user.' + userobjarr[i].id, obj);

        if(userobjarr[i].hasOwnProperty(cprop)) {
          // cur properties
          let cid = 'user.' + cprop;
          let crole = 'state'; // default role
          let cunit = ''; // default unit

          switch(typeof userobjarr[i][cprop]) {
            case 'number':
              switch(cprop) {
                case 'lat':
                  crole = 'value.gps.latitude';
                  break;
                case 'long':
                  crole = 'value.gps.longitude';
                  break;
                case 'battery':
                  crole = 'value.battery';
                  cunit = '%';
                  break;
                case 'accuracy':
                  crole = 'value.gps.accuracy';
                  cunit = 'm';
                  break;
                case 'timestamp':
                  crole = 'date';
                  break;
                default:
                  crole = 'value';
              }
              setStateEx(cid, {
                common: {
                  name: cprop,
                  desc: '',
                  type: 'number',
                  role: crole,
                  unit: cunit,
                  read: true,
                  write: false
                }
                }, userobjarr[i][cprop], true);
              break;
            case 'string':
              switch(cprop) {
                case 'photoURL':
                  crole = 'text.url';
                  break;
                case 'address':
                  crole = 'location';
                  break;
                default:
                  crole = 'text';
              }
              setStateEx(cid, {
                common: {
                  name: cprop,
                  desc: '',
                  type: 'string',
                  role: crole,
                  read: true,
                  write: false
                }
              }, userobjarr[i][cprop], true);
              break;
            case 'boolean':
              setStateEx(cid, {
                common: {
                  name: cprop,
                  desc: '',
                  type: 'boolean',
                  role: 'indicator',
                  def: false,
                  read: true,
                  write: false
                }
              }, userobjarr[i][cprop], true);
              break;
          }
        }
      }
    }
  }

  if(callback) callback(false);
}

// poll locations, devices, etc.
function poll(callback) {
  adapter.log.debug('Polling locations.');
  triggerSingleQuery(callback);
}

// notify places adapter
function notifyPlaces(userobjarr, callback) {
  let places = adapter.config.places_adapter;

  if (places && places !== '') {
    // go through all users
    for(let j=0;j<userobjarr.length;j++) {
      let cuser = userobjarr[j];

      // send message to places adapter
      adapter.sendTo(
        places, {
          user: cuser.name,
          latitude: cuser.lat,
          longitude: cuser.long,
          timestamp: Date.now(),
          address: cuser.address
        });
    }
  }

  callback(false);
}

// check fences
function checkFences(userobjarr, callback) {

  adapter.log.debug('Checking fences.');
  let fences = adapter.config.fences;

  // check fences
  for(let i=0;i<fences.length;i++) {
    let cfence = fences[i];

    // go through all users in the received structure
    for(let j=0;j<userobjarr.length;j++) {
      let cuser = userobjarr[j];

      // check user
      if(cuser.id === cfence.userid) {
        // calc distance
        let curdist = haversine(cuser.lat, cuser.long, Number(cfence.center_lat), Number(cfence.center_long));
        let cstate = curdist <= cfence.radius;

        adapter.setState('fence.' + cfence.fenceid, cstate, true);
        break;
      }
    }
  }

  callback(false);
}

// setStateEx
function setStateEx(id, common, val, ack, callback) {
  let a = {
    type: 'state',
    native: {}
  };

  let common_full = Object.assign({}, a, common);

  let cfunc = function (err) {
    adapter.setState(id, val, ack, function(err) {
      if(err) adapter.log.error('Could not create extended state id:' + id + ', val:' + val + ' because ' + err.stack);
    });
  };

  adapter.setObjectNotExists(id, common_full, cfunc);

  if(callback) callback(false);
}

// query google shared locations
function getSharedLocations(callback) {

  let options_map = {
    uri: "https://www.google.de/maps/rpc/locationsharing/read?authuser=0&pb",
    headers: {
      "Cookie": google_cookie_header
    },
    method: "GET",
    qs: {
      "authuser": 0,
      "pb": ""
    }
  };

  request(options_map, function(err, response, body){
    if(err || !response) {
      // no connection

      adapter.log.error(err);
      adapter.log.info('Connection to google maps failure.');
      if(callback) callback(true);
    } else {
      // connection successful
      adapter.log.debug('Response: ' + response.statusMessage + ' - ' + response.statusCode);

      // connection established but auth failure
      if(response.statusCode !== 200) {
        adapter.log.error('Failed getting locations: ' + response.statusCode + ' - ' + response.statusMessage + ' - ' + response.body);

        if(callback) callback(true);
      } else {
        // parse and save user locations
        try {
          let locationdata = JSON.parse(body.split('\n').slice(1, -1).join(''));
          parseLocationData(locationdata, function(err, userobjarr) {
            if(err) {
              if(callback) callback(err);
            } else {
              if(callback) callback(false, userobjarr);
            }
          });
        } catch (e) {
          //adapter.log.error('Could not parse location data. Probably authentication error. Please check cookie.');
          callback(e);
        }
      }
    }
  });
}

// parse the retrieved location data
function parseLocationData(locationdata, callback) {

  // shared location data is contained in the first element
  let perlocarr = locationdata[0];
  let myloc = locationdata[9];
  let userdataobjarr = [];

  if(myloc && myloc.length > 0) {

    extractUserLocationData(myloc,  function(err, obj) {
      if(err) {
        if(callback) callback(err);
        return
      } else {
        userdataobjarr[0] = obj;
      }
    });

  } else {
    throw new Error('No location data in response. Cookie expired.');
    adapter.log.debug('No location data: ' + JSON.stringify(locationdata, null, 2));
  }

  if(callback) callback(false, userdataobjarr);
}

// get user date and create states form
function extractUserLocationData(userdata, callback) {
  let userdataobj = {
    "id": undefined,
    "photoURL": undefined,
    "name": undefined,
    "lat": undefined,
    "long": undefined,
    "address": undefined,
    "battery": undefined,
    "timestamp": undefined,
    "accuracy": undefined
  };

  if(userdata && Array.isArray(userdata)) {
    // userdata present
    if(userdata[0] && userdata[0][0]) userdataobj['id'] = userdata[0][0];
    if(userdata[0] && userdata[0][1]) userdataobj['photoURL'] = userdata[0][1];
    if(userdata[0] && userdata[0][3]) userdataobj['name'] = userdata[0][3];
    if(userdata[1] && userdata[1][1] && userdata[1][1][2]) userdataobj['lat'] = userdata[1][1][2];
    if(userdata[1] && userdata[1][1] && userdata[1][1][1]) userdataobj['long'] = userdata[1][1][1];
    if(userdata[1] && userdata[1][4]) userdataobj['address'] = userdata[1][4];
    if(userdata[13] && userdata[13][1]) userdataobj['battery'] = userdata[13][1];
    if(userdata[1] && userdata[1][2]) userdataobj['timestamp'] = userdata[1][2];
    if(userdata[1] && userdata[1][3]) userdataobj['accuracy'] = userdata[1][3];
  }

  if(callback) callback(false, userdataobj);
}

// latitude and longitude in degree decimal notation
function haversine(deg_lat1, deg_lon1, deg_lat2, deg_lon2) {
  let lat1 = deg_lat1/180*Math.PI;
  let lon1 = deg_lon1/180*Math.PI;
  let lat2 = deg_lat2/180*Math.PI;
  let lon2 = deg_lon2/180*Math.PI;

  const R = 6372.8;
  let dLat = lat2 - lat1;
  let dLon = lon2 - lon1;

  let a = Math.sin(dLat / 2) * Math.sin(dLat /2) + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon /2);
  return 2.0 * R * Math.asin(Math.sqrt(a)) * 1000;
}
