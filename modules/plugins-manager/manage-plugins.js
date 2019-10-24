//############################################################################################
//##
//# Copyright (C) 2014-2018 Dario Bruneo, Francesco Longo, Giovanni Merlino, Nicola Peditto
//##
//# Licensed under the Apache License, Version 2.0 (the "License");
//# you may not use this file except in compliance with the License.
//# You may obtain a copy of the License at
//##
//# http://www.apache.org/licenses/LICENSE-2.0
//##
//# Unless required by applicable law or agreed to in writing, software
//# distributed under the License is distributed on an "AS IS" BASIS,
//# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//# See the License for the specific language governing permissions and
//# limitations under the License.
//##
//############################################################################################


//service logging configuration: "pluginsManager"   
var logger = log4js.getLogger('pluginsManager');
logger.setLevel(loglevel);

var fs = require("fs");
var Q = require("q");
var cp = require('child_process');  	//In order to create a wrapper process for each active plugin.
var running = require('is-running');  	//In order to verify if a plugin is alive or not.
var md5 = require('md5');
var net = require('net');

//const {PythonShell} = require("python-shell");
var PythonShell = require('python-shell');

session_plugins = null;

var plugins = {};	// This data structure collects all status information of all plugins started in this LR session
var PLUGINS_SETTING = process.env.IOTRONIC_HOME + '/plugins/plugins.json';
var PLUGINS_STORE = process.env.IOTRONIC_HOME + '/plugins/';
var LIGHTNINGROD_HOME = process.env.LIGHTNINGROD_HOME;


PLUGIN_LOGGERS = [];


SETTINGS = process.env.IOTRONIC_HOME+'/settings.json';
nconf = require('nconf');
nconf.file ({file: SETTINGS});

alive_timer = nconf.get('config:board:modules:plugins_manager:alive_timer');
if (isNaN(alive_timer))
	alive_timer = 60; //set default value

var PLUGIN_MODULE_LOADED = false;

CHECKSUMS_PLUGINS_LIST = [];

var nonMaintenancePlugins = { "plugins":{} };

// This function checks if the plugin process is still alive otherwise starts it
function pluginStarter(plugin_name, timer, plugin_json_name, skip, plugin_checksum) {

	try{

		// Get the plugin's configuration.
		var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));

		var status = pluginsConf.plugins[plugin_name].status;
		var pid = pluginsConf.plugins[plugin_name].pid;
		var autostart = pluginsConf.plugins[plugin_name].autostart;
		var plugin_type = pluginsConf.plugins[plugin_name].type;
		var plugin_version = pluginsConf.plugins[plugin_name].version;

		// The board restarts all the plugins with status "on" (this status happens after a crash of L-R/board) or with autostart parameter set at true (because some plugins need to start at boot time).
		if (status == "on" || autostart == "true"){

			// if the pid of plugin is empty (wrong status)
			if (pid == '') {

				plugins[plugin_name]={
					child: "",
					pid: pid,
					alive: false,
					timer: timer
				}

			}
			else if( pid == null){

				// if the plugin was just injected it does not have the "pid" field in the plugins.json conf file
				skip = "true";

				plugins[plugin_name]={
					child: "",
					pid: pid,
					alive: null,
					timer: timer
				}

			}
			else{

				// if the pid is specified and the device is in the after reboot status of the device/LR or after a crash of the plugin process
				plugins[plugin_name]={
					child: "",
					pid: pid,
					alive: running(pid),
					timer: timer
				}

			}


			if( plugins[plugin_name].alive === true){

				if(CHECKSUMS_PLUGINS_LIST.length == 0){
					// the plugin is normally running
					console.log('[PLUGIN] |----> PluginChecker - "'+ plugin_name + '" with PID: ' + plugins[plugin_name].pid + ' alive: '+ plugins[plugin_name].alive );

				}
				else{

					if(plugin_type == "nodejs")
						var ext = '.js';
					else if(plugin_type == "python")
						var ext ='.py';

					var checksum = md5(	fs.readFileSync(PLUGINS_STORE + plugin_name + "/"+plugin_name+ext, 'utf8'));

					var plugin_checksum = CHECKSUMS_PLUGINS_LIST[plugin_name];

					if(checksum != plugin_checksum){

						process.kill(plugins[plugin_name].pid);

						// the plugin is not alive and its checksum mismatches!
						logger.warn( '[PLUGIN] - PluginChecker - "'+ plugin_name + '" - The plugin was modified: checksum mismatches!');
						clearPluginTimer(plugin_name);

						pluginsConf.plugins[plugin_name].status = "off";
						pluginsConf.plugins[plugin_name].pid = "";

						// updates the JSON file
						fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function(err) {

							if(err) {
								logger.warn('[PLUGIN] --> Error updating "'+plugin_name + '" plugin in "plugins.json": '+err);

							} else {

								logger.debug('[PLUGIN] --> Plugin "'+plugin_name + '" local status updated.');
							}

						});

						session_plugins.call('s4t.iotronic.plugin.invalidPlugin', [boardCode, plugin_name, plugin_version]).then(

							function (rpc_response) {

								if (rpc_response.result == "ERROR") {

									logger.error("[PLUGIN] --> Error notification plugin checksum mismatch for '" + plugin_name + "' plugin: " + rpc_response.message);

								}
								else {

									logger.debug("[PLUGIN] - Invalidation plugin response: " + rpc_response.message);

								}

							}
						);



					}
					else{
						// the plugin is normally running
						console.log('[PLUGIN] - PluginChecker - "'+ plugin_name + '" with PID: ' + plugins[plugin_name].pid + ' alive: '+ plugins[plugin_name].alive );

					}


				}


			}
			else if( skip === "true") {

				// the plugin is in injected state and it doesn't need to be restarted
				logger.info("[PLUGIN] - " + plugin_name + ' is a new plugin! status: injected - It is needed to start it the first time!' );
				clearPluginTimer(plugin_name);

			}
			else if( plugins[plugin_name].alive === false || skip === "false") {

				if(plugin_type == "nodejs")
					var ext = '.js';
				else if(plugin_type == "python")
					var ext ='.py';

				var checksum = md5(	fs.readFileSync(PLUGINS_STORE + plugin_name + "/"+plugin_name+ext, 'utf8'));

				if(CHECKSUMS_PLUGINS_LIST.length != 0)			// LR is connected to Iotronic and retrieved the plugins checksum list
					var plugin_checksum = CHECKSUMS_PLUGINS_LIST[plugin_name];


				// If LR started without connection CHECKSUMS_PLUGINS_LIST.length is ZERO and the enabled plugin will start without checksum check
				// OTHERWISE the plugins will start only if their checksum are validated!
				if( (checksum === plugin_checksum) || (CHECKSUMS_PLUGINS_LIST.length == 0) ){

					// the plugin is not alive: we are in the state after a reboot of the device/LR or after a crash of the plugin process

					if(plugins[plugin_name].pid == "")
						logger.warn( '[PLUGIN] - PluginChecker - "'+ plugin_name + '" - No such process and PID found!'+ ' - alive: '+ plugins[plugin_name].alive +' - Checksum accepted ('+checksum+') - Restarting...');
					else
						logger.warn( '[PLUGIN] - PluginChecker - "'+ plugin_name + '" - No such process with PID "'+plugins[plugin_name].pid+'" found!'+ ' - alive: '+ plugins[plugin_name].alive +' - Checksum accepted ('+checksum+') - Restarting...');

					// If the schema json file exists the board will create a child_process to restart the plugin and update the status and the PID value
					if (fs.existsSync(plugin_json_name) === true){

						// Check the plugin type: "nodejs" or "python"

						switch (plugin_type) {

							case 'nodejs':

								//Create a new process that has wrapper that manages the plugin execution
								try{

									plugins[plugin_name].child = cp.fork(LIGHTNINGROD_HOME + '/modules/plugins-manager/nodejs/async-wrapper');

									var plugin_json_schema = JSON.parse(fs.readFileSync(plugin_json_name));
									var input_message = {
										"plugin_name": plugin_name,
										"plugin_json": plugin_json_schema
									};

									logger.info("[PLUGIN] --> "+ plugin_name + " - Input parameters: "+ fs.readFileSync(plugin_json_name));

									pluginsConf.plugins[plugin_name].pid = plugins[plugin_name].child.pid;
									pluginsConf.plugins[plugin_name].status = "on";

									plugins[plugin_name].child.send(input_message);

									plugins[plugin_name].child.on('message', function(msg) {

										if(msg.name != undefined){

											if (msg.status === "alive"){

												//updates the JSON file plugins.json
												try{

													fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function(err) {
														if(err) {
															logger.error('[PLUGIN] --> '+ plugin_name + ' - Error writing JSON file ' + PLUGINS_SETTING + ': ' + err);
														} else {
															logger.debug("[PLUGIN] --> "+ plugin_name + " - JSON file " + PLUGINS_SETTING + " updated!");
														}
													});

													if(CHECKSUMS_PLUGINS_LIST.length != 0){

														iotronic_plugin_status = "restarted";
														session_plugins.call('s4t.iotronic.plugin.updateStatus', [boardCode, plugin_name, plugin_version, iotronic_plugin_status]).then(

															function (rpc_response) {

																if (rpc_response.result == "ERROR") {
																	logger.error("[PLUGIN] --> Error notification plugin status for '" + plugin_name + "' plugin: " + rpc_response.message);
																}
																else {
																	logger.debug("[PLUGIN] - Iotronic updating status response: " + rpc_response.message);
																	logger.info("[PLUGIN] - Plugin '"+plugin_name + "' environment cleaned and Iotronic status updated to " + iotronic_plugin_status);
																}

															}
														);

													}


												}
												catch(err){
													logger.error('[PLUGIN] --> '+ plugin_name + ' - Error updating JSON file ' + PLUGINS_SETTING + ': ' + err);
												}

												logger.info("[PLUGIN] --> "+ msg.name + " - " + msg.status + " - Plugin initialization completed: PID = " + pluginsConf.plugins[plugin_name].pid +" - Status = " + pluginsConf.plugins[plugin_name].status);


											} else if(msg.level === "error") {

												logger.error("[PLUGIN] - "+ msg.name + " - " + msg.logmsg);

											} else if(msg.level === "warn") {

												logger.warn("[PLUGIN] - "+ msg.name + " - " + msg.logmsg);

												if(msg.status === "failed"){

													// if plugin crashes

													logger.error("[PLUGIN] - '"+ plugin_name + "' - plugin process failed: "+ msg.name + " - " + msg.logmsg);

													clearPluginTimer(plugin_name);

													if(CHECKSUMS_PLUGINS_LIST.length != 0){
														iotronic_plugin_status = "failed";
														session_plugins.call('s4t.iotronic.plugin.updateStatus', [boardCode, plugin_name, plugin_version, iotronic_plugin_status]).then(

															function (rpc_response) {

																if (rpc_response.result == "ERROR") {
																	logger.error("[PLUGIN] --> Error notification plugin status for '" + plugin_name + "' plugin: " + rpc_response.message);
																}
																else {
																	logger.debug("[PLUGIN] - Iotronic updating status response: " + rpc_response.message);
																	logger.info("[PLUGIN] - Plugin '"+plugin_name + "' environment cleaned and Iotronic status updated to " + iotronic_plugin_status);
																}

															}
														);
													}

												}

											} else{

												logger.info("[PLUGIN] --> "+ msg.name + " - " + msg.logmsg);

											}


										} else{
											//used to manage the first message coming from the child process
											logger.info("[PLUGIN] --> "+ msg);
										}

									});


								}
								catch(err){
									logger.error('[PLUGIN] --> Error starting "'+plugin_name+'" plugin: ' + err);
								}


								break;

							case 'python':

								var plugin_json = fs.readFileSync(plugin_json_name);

								pyAsyncStarter(plugin_name, plugin_json, plugin_checksum, "restart", plugin_version);

								break;


							default:
								logger.warn('[PLUGIN] - "' + plugin_name + '": wrong plugin type: ' + plugin_type);
								break;

						}



					}
					else{

						//If the schema json file doesn't exist the related plugin will be not restarted and the value of its PID will be cleaned.

						//updates the plugins.json JSON file
						try{

							logger.warn('[PLUGIN] --> '+ plugin_name + ' - I can not restart plugin!!! JSON file '+ plugin_json_name +' does not exist!');

							pluginsConf.plugins[plugin_name].pid = "";

							fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function(err) {
								if(err) {
									logger.error('[PLUGIN] --> '+ plugin_name + ' - Error writing JSON file ' + PLUGINS_SETTING + ': ' + err);
								} else {
									logger.info('[PLUGIN] --> '+ plugin_name + ' - JSON file ' + PLUGINS_SETTING + ' updated: PID value cleaned!');
								}
							});

							logger.warn('[PLUGIN] --> '+ plugin_name + ' - Please call the RUN command again for this plugin!');

						}
						catch(err){
							logger.error('[PLUGIN] --> '+ plugin_name + ' - Error updating JSON file ' + PLUGINS_SETTING + ': ' + err);
						}

					}


				}
				else{

					// the plugin is not alive and its checksum mismatches!
					logger.warn( '[PLUGIN] - PluginChecker - '+ plugin_name + ' - The plugin is not alive and it will not be restarted: checksum mismatches!');
					clearPluginTimer(plugin_name);

					session_plugins.call('s4t.iotronic.plugin.invalidPlugin', [boardCode, plugin_name, plugin_version]).then(

						function (rpc_response) {

							if (rpc_response.result == "ERROR") {

								logger.error("[PLUGIN] --> Error notification plugin checksum mismatch for '" + plugin_name + "' plugin: " + rpc_response.message);

							}
							else {

								logger.debug("[PLUGIN] - Invalidation plugin response: " + rpc_response.message);

							}

						}
					);

				}


			}



		}


	}
	catch(err){
		logger.error('[PLUGIN] --> '+ plugin_name + ' - Error loading plugin: ' + err);
	}

    
}


// This function delete the timer associated with a plugin
function clearPluginTimer(plugin_name) {
  
    try{

    	if(plugins[plugin_name] != undefined){
			if( plugins[plugin_name].timer == null){

				logger.debug("[PLUGIN] --> '" + plugin_name + "': no timer to clear!");

			}else{
				clearInterval( plugins[plugin_name].timer );
				logger.debug("[PLUGIN] --> '" + plugin_name + "': timer cleared!");
			}

		}

    }  
    catch(err){
		logger.warn('[PLUGIN] --> Error in clearing timer for plugin "'+plugin_name+'": '+ err);
    }
    
}


// Function used to delete all driver files during driver removing from the board
function deleteFolderRecursive(path){

	if( fs.existsSync(path) ) {
		fs.readdirSync(path).forEach(function(file,index){
			var curPath = path + "/" + file;
			if(fs.lstatSync(curPath).isDirectory()) {
				// recurse
				deleteFolderRecursive(curPath);
			} else {
				// delete file
				fs.unlinkSync(curPath);
			}
		});
		fs.rmdirSync(path);
	}

}


// Function to clean all plugin data (folder and configuration)
function cleanPluginData(plugin_name){

	var response = {
		message: '',
		result: ''
	};

	var d = Q.defer();

	var plugin_folder = PLUGINS_STORE + plugin_name;

	if ( fs.existsSync(plugin_folder) === true ){

		deleteFolderRecursive(plugin_folder);		//delete plugin files and the folder

		logger.debug('[PLUGIN] --> Plugin folder deleted.');

	}
	else{
		logger.debug('[PLUGIN] --> Plugin folder already deleted.');
	}

	logger.debug('[PLUGIN] --> Plugin data cleaning...');

	//Reading the plugins configuration file
	var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));

	if(	pluginsConf["plugins"].hasOwnProperty(plugin_name)	){

		var pluginStatus = pluginsConf.plugins[plugin_name]['status'];

		pluginsConf.plugins[plugin_name]=null;
		delete pluginsConf.plugins[plugin_name];

		fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function(err) {

			if(err) {
				response.result = "ERROR";
				response.message = "plugin.json updating FAILED: "+err;
				d.resolve(response);

			} else {

				logger.debug("[PLUGIN] ----> plugins.json file updated!");
				response.result = "SUCCESS";
				d.resolve(response);

			}

		});

	}else{
		logger.debug("[PLUGIN] ----> plugins.json already clean!");
		response.result = "SUCCESS";
		d.resolve(response);
	}

	return d.promise;

}


function pyAsyncStarter(plugin_name, plugin_json, plugin_checksum, action, version) {

	var d = Q.defer();

	var response = {
		message: '',
		result: ''
	};

	var PY_PID = null;
	var s_server = null;
	var socketPath = '/tmp/plugin-'+plugin_name;

	// Callback for socket
	var handler = function(socket){

		// Listen for data from client
		socket.on('data',function(bytes){

			var data = bytes.toString(); 			// Decode byte string
			var data_parsed = JSON.parse(data); 	// Parse JSON response

			if(data_parsed.result == "ERROR"){

				response.result = "ERROR";
				response.message = data_parsed.payload;
				logger.info('[PLUGIN] - Error in '+plugin_name + ':\n'+JSON.stringify(response.message, null, "\t"));
				d.resolve(response);

			}else{

				response.result = "SUCCESS";
				response.message = data_parsed.payload;
				logger.info('[PLUGIN] - '+plugin_name + ': '+ JSON.stringify(response.message, null, "\t"));
				d.resolve(response);

			}

		});

		// On client close
		socket.on('end', function() {
			logger.debug('[PLUGIN-SOCKET] - Socket disconnected');
			s_server.close(function(){
				logger.debug('[PLUGIN-SOCKET] - Server socket closed');
			});

		});


	};

	// Remove an existing socket
	try{

		fs.unlink(socketPath, function(){
				// Create the server, give it our callback handler and listen at the path

				s_server = net.createServer(handler).listen(socketPath, function(){
					logger.debug('[PLUGIN-SOCKET] - Socket in listening...');
					logger.debug('[PLUGIN-SOCKET] --> socket: '+socketPath);
				})

			}
		);
	}
	catch(err){

		response.result = "ERROR";
		response.message = '(async) Error unlink socket file: ' + err;
		logger.error('[PLUGIN] - '+plugin_name + ' - '+response.message);
		d.resolve(response);

	}


	// START ASYNC PLUGIN (WRAPPER)
	try {

		var options = {
			mode: 'text',
			pythonPath: '/usr/bin/python3',
			pythonOptions: ['-u'],
			scriptPath: __dirname,
			args: [plugin_name, version, plugin_json, JSON.stringify(lyt_device)]
		};

		var pyshell = new PythonShell('./python/async-wrapper.py', options);
		PY_PID = pyshell.childProcess.pid;
		logger.debug("[PLUGIN-SHELL] - PID wrapper: " + PY_PID);

	}
	catch(err) {
		logger.error('[PLUGIN] - '+plugin_name + ' - '+JSON.stringify(err) );
	}


	//Creating the plugin json schema
	var plugin_folder = PLUGINS_STORE + plugin_name;
	var schema_outputFilename = plugin_folder + "/" + plugin_name + '.json';

	// Reading the plugins.json configuration file
	try{

		var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));
		var pluginsSchemaConf = JSON.parse(fs.readFileSync(schema_outputFilename, 'utf8'));

		//Get the autostart parameter from the schema just uploaded
		plugin_autostart = pluginsSchemaConf.autostart;

	}
	catch(err){

		response.result = "ERROR";
		response.message = 'Error parsing plugins.json configuration file: ' + err;
		logger.error('[PLUGIN] - '+plugin_name + ' - '+response.message);
		d.resolve(response);

	}

	// UPDATE PLUGINS SETTINGS
	if (action == "start") {

		fs.writeFile(schema_outputFilename, plugin_json, function (err) {

			if (err) {
				response.result = "ERROR";
				response.message = 'Error opening ' + plugin_name + '.json file: ' + err;
				logger.error('[PLUGIN] - "' + plugin_name + '" - ' + response.message);
				d.resolve(response);

			} else {

				logger.info('[PLUGIN] - ' + plugin_name + ' - Plugin JSON schema saved to ' + schema_outputFilename);

				// Updating the plugins.json file:
				// - check if the user changed the autostart parameter at this stage
				if (plugin_autostart != undefined) {

					pluginsConf.plugins[plugin_name].autostart = plugin_autostart;
					logger.info('[PLUGIN] - ' + plugin_name + ' - Autostart parameter set by user to ' + plugin_autostart);

				} else {

					logger.info('[PLUGIN] - ' + plugin_name + ' - Autostart parameter not changed!');

				}

				// - change the plugin status from "off" to "on" and update the PID value
				pluginsConf.plugins[plugin_name].status = "on";
				pluginsConf.plugins[plugin_name].pid = PY_PID;

				fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function (err) {

					if (err) {
						logger.error('[PLUGIN] - ' + plugin_name + ' - Error opening ' + plugin_name + '.json file: ' + err);
					} else {
						logger.info('[PLUGIN] - ' + plugin_name + ' - plugins.json updated -> autostart < ' + pluginsConf.plugins[plugin_name].autostart + ' > - status < ' + pluginsConf.plugins[plugin_name].status + ' > ' + pluginsConf.plugins[plugin_name].pid);

						// Start a timer to check every X minutes if the plugin is still alive!
						exports.pluginKeepAlive(plugin_name, plugin_checksum, null);

					}

				});

			}

		});

	}
	else if (action == "restart") {

		// - change the plugin status from "off" to "on" and update the PID value
		pluginsConf.plugins[plugin_name].status = "on";
		pluginsConf.plugins[plugin_name].pid = PY_PID;

		fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function (err) {

			if (err) {
				logger.error('[PLUGIN] - ' + plugin_name + ' - Error opening ' + plugin_name + '.json file: ' + err);
			} else {
				logger.info('[PLUGIN] - ' + plugin_name + ' - plugins.json updated -> autostart < ' + pluginsConf.plugins[plugin_name].autostart + ' > - status < ' + pluginsConf.plugins[plugin_name].status + ' > ' + pluginsConf.plugins[plugin_name].pid);

			}

		});

		// UPDATE PLUGIN STATUS IN IOTRONIC
		try{

			iotronic_plugin_status = "restarted";

			session_plugins.call('s4t.iotronic.plugin.updateStatus', [boardCode, plugin_name, version, iotronic_plugin_status]).then(
				function (rpc_response) {

					if (rpc_response.result == "ERROR") {

						response.result = "ERROR";
						response.message = 'Error notification plugin status: ' + rpc_response.message;
						logger.error("[PLUGIN] --> Error notification plugin status for '" + plugin_name + "' plugin: " + rpc_response.message);

					} else {

						logger.debug("[PLUGIN] - Iotronic updating status response: " + rpc_response.message);

						response.result = "SUCCESS";
						response.message = "Plugin status updated to '" + iotronic_plugin_status +"'";
						logger.info("[PLUGIN] - plugin '" + plugin_name + "': " + response.message);

					}

				}
			);
		}
		catch(err){

			response.result = "ERROR";

			if(session_plugins == null){
				response.message = 'update plugin status error: no Iotronic session established!';
				logger.warn('[PLUGIN] - '+plugin_name + ' - '+response.message);
			}
			else{
				response.message = 'update plugin status error: ' + err;
				logger.error('[PLUGIN] - '+plugin_name + ' - '+response.message);
			}

		}


	}






	//if(logger.level.levelStr == 'DEBUG')
	// listening 'print' output
	pyshell.on('message', function (message) {
		// received a message sent from the Python script (a simple "print" statement)
		console.log("[PLUGIN-WRAPPER] - PYTHON: "+message);
	});

	// end the input stream and allow the process to exit
	pyshell.end(function (err, code, signal) {

		//Reload plugins.json to get latest info
		var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));

		if (err){

			try{

				PLUGIN_LOGGERS[plugin_name].warn("Plugin '"+plugin_name+"' error logs: \n" + JSON.stringify(err, null, "\t"));
			}
			catch(err){
				logger.warn('[PLUGIN] - '+plugin_name + ' - Plugin logger error: ' + err);
				logger.warn("Plugin '"+plugin_name+"' error logs: \n" + JSON.stringify(err, null, "\t"));
			}

			response.result = "ERROR";
			response.message = "Error plugin execution: please check plugin logs: \n" + err.traceback;

			pluginsConf.plugins[plugin_name].status = "off";
			pluginsConf.plugins[plugin_name].pid = "";

			// updates the JSON file
			fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function(err) {

				if(err) {
					clearPluginTimer(plugin_name);
					response.result = "ERROR";
					response.message = 'Error writing plugins.json: '+ err;
					logger.error('[PLUGIN] - pyshell error in plugin '+plugin_name + ' error: '+response.message);
					d.resolve(response);

				} else {
					logger.debug("[PLUGIN] --> " + PLUGINS_SETTING + " updated!");
					clearPluginTimer(plugin_name);
					d.resolve(response);
				}

			})

		}
		else{

			try {

				logger.debug('[PLUGIN-SHELL] - Python shell of "' + plugin_name + '" plugin terminated: {signal: ' + signal + ', code: ' + code + '}');

				if (signal == null && code == 0) {

					logger.warn("[PLUGIN-SHELL] --> '" + plugin_name + "' plugin exited!");

					pluginsConf.plugins[plugin_name].status = "off";
					pluginsConf.plugins[plugin_name].pid = "";

					// updates the JSON file
					fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function (err) {

						if (err) {

							response.result = "ERROR";
							response.message = 'Error writing plugins.json: ' + err;
							logger.error('[PLUGIN] - stop plugin ' + plugin_name + ' error: ' + response.message);
							d.resolve(response);

						} else {

							logger.debug("[PLUGIN] --> " + PLUGINS_SETTING + " updated!");
							//clearPluginTimer(plugin_name); //if enabled a plugin exited in "normal" state (not stopped by Iotronic) it will not be reloaded by "autostart": "true"

							iotronic_plugin_status = "exited";

							try{
								session_plugins.call('s4t.iotronic.plugin.updateStatus', [boardCode, plugin_name, version, iotronic_plugin_status]).then(
									function (rpc_response) {

										if (rpc_response.result == "ERROR") {

											response.result = "ERROR";
											response.message = 'Error notification plugin status: ' + rpc_response.message;
											logger.error("[PLUGIN] --> Error notification plugin status for '" + plugin_name + "' plugin: " + rpc_response.message);
											d.resolve(response);

										} else {

											logger.debug("[PLUGIN] - Iotronic updating status response: " + rpc_response.message);

											response.result = "SUCCESS";
											response.message = "Plugin environment cleaned and Iotronic status updated to '" + iotronic_plugin_status +"'";
											logger.info("[PLUGIN] - plugin '" + plugin_name + "': " + response.message);
											d.resolve(response);

										}

									}
								);
							}
							catch(err){

								response.result = "ERROR";

								if(session_plugins == null){
									response.message = 'update plugin status error: no Iotronic session established!';
									logger.warn('[PLUGIN] - '+plugin_name + ' - '+response.message);
								}
								else{
									response.message = 'update plugin status error: ' + err;
									logger.error('[PLUGIN] - '+plugin_name + ' - '+response.message);
								}

							}





						}

					});

				} else {
					logger.debug("[PLUGIN-SHELL] --> Python plugin '" + plugin_name + "' terminated!")
				}

			}
			catch(err){

				response.result = "ERROR";
				response.message = 'Error in pyshell.end (closing): ' + err;
				logger.error('[PLUGIN] - '+plugin_name + ' - '+response.message);
				d.resolve(response);

			}
		}



	});


	return d.promise;

}


function pySyncStarter(plugin_name, version, plugin_json) {

	var d = Q.defer();

	var response = {
		message: '',
		result: ''
	};

	var s_server = null;
	var socketPath = '/tmp/plugin-'+plugin_name;

	var pyshell = null;

	// Callback for socket
	var handler = function(socket){

		// Listen for data from client
		socket.on('data', function(bytes){

			var data = bytes.toString(); 			// Decode byte string
			var data_parsed = JSON.parse(data); 	// Parse JSON response

			if(data_parsed.result == "ERROR"){

				response.result = "ERROR";
				response.message = "Error in plugin execution: " + data_parsed.payload;
				logger.warn('[PLUGIN] - Error in '+plugin_name + ':\n'+JSON.stringify(response.message, null, "\t"));
				d.resolve(response);

			}else{
				
				try{

					response.result = "SUCCESS";
					response.message = data_parsed.payload;
					logger.info('[PLUGIN] - '+plugin_name + ': '+ JSON.stringify(response.message, null, "\t"));
					d.resolve(response);

				}
				catch(err){
					response.result = "ERROR";
					response.message = JSON.stringify(err);
					logger.error('Error parsing '+plugin_name + ' plugin response: '+ response.message);
					d.resolve(response);
				}


			}


		});

		// On client close
		socket.on('end', function() {

			logger.debug('[PLUGIN-SOCKET] - Socket disconnected');

			s_server.close(function(){

				logger.debug('[PLUGIN-SOCKET] - Server socket closed');

			});

		});

	};

	try {
		// Remove an existing plugin socket
		fs.unlink(socketPath, function () {

				var plugin_folder = PLUGINS_STORE + plugin_name;
				var schema_outputFilename = plugin_folder + "/" + plugin_name + '.json';

				// Create the server, give it our callback handler and listen at the path
				s_server = net.createServer(handler).listen(socketPath, function () {

					logger.debug('[PLUGIN-SOCKET] - Socket in listening...');
					logger.debug('[PLUGIN-SOCKET] --> socket: ' + socketPath);

					// after socket creation we will start the plugin wrapper
					var options = {
						mode: 'text',
						pythonPath: '/usr/bin/python3',
						pythonOptions: ['-u'],
						scriptPath: __dirname,
						args: [plugin_name, version, plugin_json, JSON.stringify(lyt_device)]
					};

					pyshell = new PythonShell('./python/sync-wrapper.py', options);
					// it will create a python instance like this:
					// python -u /opt/stack4things/lightning-rod/modules/plugins-manager/python/sync-wrapper.py py_sync {"name":"S4T"}

					logger.debug("[PLUGIN-SHELL] - PID wrapper: " + pyshell.childProcess.pid);

					if (logger.level.levelStr == 'DEBUG')
					// listening 'print' output
						pyshell.on('message', function (message) {
							// received a message sent from the Python script (a simple "print" statement)
							console.log("[PLUGIN-WRAPPER] - PYTHON: " + message);
						});


					// end the input stream and allow the process to exit
					pyshell.end(function (err, code, signal) {

						if (err) {

							response.result = "ERROR";
							response.message = err;
							d.resolve(response);

						} else {
							logger.debug('[PLUGIN-SHELL] - Python shell terminated: {signal: ' + signal + ', code: ' + code + '}');
						}

					});


					//update parameters and plugins.json conf file
					fs.writeFile(schema_outputFilename, plugin_json, function (err) {

						if (err) {

							logger.error('[PLUGIN] --> Error parsing ' + plugin_name + '.json file: ' + err);

						} else {

							logger.debug('[PLUGIN] --> Plugin JSON schema saved to ' + schema_outputFilename);

							try {

								//Reading the plugin configuration file
								var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));

								// - change the plugin status from "off" to "on" and update the PID value
								pluginsConf.plugins[plugin_name].status = "on";
								pluginsConf.plugins[plugin_name].pid = pyshell.childProcess.pid;

								//updates the JSON file
								fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function (err) {

									if (err) {
										logger.error('[PLUGIN] --> Error writing plugins.json file: ' + err);
									} else {
										logger.debug("[PLUGIN] --> JSON file plugins.json updated -> " + plugin_name + ':  status < ' + pluginsConf.plugins[plugin_name].status + ' > ' + pluginsConf.plugins[plugin_name].pid);
									}

								});

							} catch (err) {
								logger.error('Error updating JSON file plugins.json: ' + JSON.stringify(err));
							}


						}

					});


				})


			}
		);
	}
	catch(err){

		response.result = "ERROR";
		response.message = '(sync) Error unlink socket file: ' + err;
		logger.error('[PLUGIN] - '+plugin_name + ' - '+response.message);
		d.resolve(response);

	}

	return d.promise;

}


// RPC to execute a syncronous plugin ("call" as the exection of a command that returns a value to the "caller"): it is called by Iotronic via RPC
exports.call = function (args){

	var d = Q.defer();

	var response = {
		message: '',
		result: ''
	};

	try {

		//Parsing the input arguments
		var plugin_name = String(args[0]);
		var plugin_json = String(args[1]);
		var plugin_checksum = String(args[2]);

		logger.info('[PLUGIN] - Sync plugin RPC called for plugin "' + plugin_name + '" plugin...');
		logger.info("[PLUGIN] --> Input parameters:\n" + plugin_json);

		try {
			//Reading the plugin configuration file
			var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));

			var status = pluginsConf.plugins[plugin_name].status;
			var plugin_type = pluginsConf.plugins[plugin_name].type;

		}
		catch (err) {
			response.result = "ERROR";
			response.message = 'Error parsing plugins.json!';
			logger.error('[PLUGIN] - "' + plugin_name + '" plugin execution error: ' + response.message);
			d.resolve(response);
		}


		if (plugin_type == "nodejs")
			var ext = '.js';
		else if (plugin_type == "python")
			var ext = '.py';


		var checksum = md5(fs.readFileSync(PLUGINS_STORE + plugin_name + "/" + plugin_name + ext, 'utf8'));

		if (checksum === plugin_checksum) {

			// The autostart parameter at RUN stage is OPTIONAL. It is used at this stage if the user needs to change the boot execution configuration of the plugin after the INJECTION stage.
			var plugin_autostart = "";

			logger.info('[PLUGIN] - Execution request for \"' + plugin_name + '\" plugin with parameter json: ' + plugin_json);

			//If the plugin exists
			if (pluginsConf["plugins"].hasOwnProperty(plugin_name)) {

				logger.info("[PLUGIN] --> Plugin successfully loaded!");

				//Check the plugin status
				var status = pluginsConf.plugins[plugin_name].status;
				var version = pluginsConf.plugins[plugin_name].version;

				if (status == "off" || status == "injected") {

					logger.info("[PLUGIN] --> Plugin " + plugin_name + " being started");

					// Check the plugin type: "nodejs" or "python"
					switch (plugin_type) {

						case 'nodejs':

							logger.info("[PLUGIN] --> plugin type: " + plugin_type);

							//set plugin logger
							var api = require(LIGHTNINGROD_HOME + '/modules/plugins-manager/nodejs/plugin-apis');

							if (PLUGIN_LOGGERS[plugin_name] == undefined) {
								PLUGIN_LOGGERS[plugin_name] = api.getLogger(plugin_name, 'debug');
							}

							//Create a new process that has wrapper that manages the plugin execution
							var child = cp.fork(LIGHTNINGROD_HOME + '/modules/plugins-manager/nodejs/sync-wrapper', {
								silent: true,
							});

							//Prepare the message I will send to the process with name of the plugin to start and json file as argument
							var input_message = {
								"plugin_name": plugin_name,
								"plugin_json": JSON.parse(plugin_json)
							};

							child.on('message', function (msg) {

								if (msg.name != undefined) {

									if (msg.status === "alive") {

										//Creating the plugin json schema
										var plugin_folder = PLUGINS_STORE + plugin_name;
										var schema_outputFilename = plugin_folder + "/" + plugin_name + '.json';

										//update parameters and plugins.json conf file
										fs.writeFile(schema_outputFilename, plugin_json, function (err) {

											if (err) {

												logger.error('[PLUGIN] --> Error parsing ' + plugin_name + '.json file: ' + err);

											} else {

												logger.info('[PLUGIN] --> Plugin JSON schema saved to ' + schema_outputFilename);

												// - change the plugin status from "off" to "on" and update the PID value
												pluginsConf.plugins[plugin_name].status = "on";
												pluginsConf.plugins[plugin_name].pid = child.pid;

												fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function (err) {

													if (err) {
														logger.error('[PLUGIN] --> Error writing plugins.json file: ' + err);
													} else {
														logger.info("[PLUGIN] --> JSON file plugins.json updated -> " + plugin_name + ':  status < ' + pluginsConf.plugins[plugin_name].status + ' > ' + pluginsConf.plugins[plugin_name].pid);
													}

												});

											}

										});


									} else if (msg.status === "finish") {

										logger.info("[PLUGIN] --> RESULT " + msg.name + ": ", msg.logmsg);
										d.resolve(msg.logmsg);

									} else if (msg.status === "fault") {

										logger.warn("[PLUGIN] --> FAULT " + msg.name + ": ", msg.logmsg);
										d.resolve(msg.logmsg);

									} else if (msg.level === "error") {

										logger.error("[PLUGIN] --> ERROR " + msg.name + ": " + msg.logmsg);

									} else if (msg.level === "warn") {

										// logger.warn("[PLUGIN] - "+ msg.name + " - " + msg.logmsg);

										if (msg.status === "exited") {

											// if plugin crashes

											logger.warn("[PLUGIN] - '" + plugin_name + "' - plugin process exited: " + msg.name + " - " + msg.logmsg);

											/*
											iotronic_plugin_status = "exited";
											session_plugins.call('s4t.iotronic.plugin.updateStatus', [boardCode, plugin_name, version, iotronic_plugin_status]).then(
												function (rpc_response) {

													if (rpc_response.result == "ERROR") {

														response.result = "ERROR";
														response.message = 'Error notification plugin status: ' + rpc_response.message;
														logger.error("[PLUGIN] --> Error notification plugin status for '" + plugin_name + "' plugin: " + rpc_response.message);

													} else {

														logger.debug("[PLUGIN] - Iotronic updating status response: " + rpc_response.message);

														response.result = "SUCCESS";
														response.message = 'Plugin environment cleaned and Iotronic status updated to ' + iotronic_plugin_status;
														logger.info("[PLUGIN] - plugin '" + plugin_name + "': " + response.message);

													}

												}
											);
											*/

										}

									} else {
										logger.info("[PLUGIN] --> " + msg.name + ": " + msg.logmsg);

									}

								} else {
									//serve per gestire il primo messaggio alla creazione del child
									logger.info("[PLUGIN] --> " + msg);
								}


							});

							child.stderr.on('data', function (data) {

								var log_plug = data;
								PLUGIN_LOGGERS[plugin_name].warn("Plugin '" + plugin_name + "' error logs: \n" + log_plug);
								response.result = "ERROR";
								response.message = 'Error in plugin execution: please check plugin logs!'; //\n'+ log_plug;
								d.resolve(response);

							});

							//I send the input to the wrapper so that it can launch the proper plugin with the proper json file as argument
							child.send(input_message);


							break;


						case 'python':

							pySyncStarter(plugin_name, version, plugin_json).then(
								function (execRes) {

									if (execRes.result == "ERROR") {

										// logger.error("[PLUGIN] - '" + plugin_name + "' plugin execution error: "+JSON.stringify(execRes, null, "\t"));

										d.resolve(execRes);

									} else if (execRes.result == "SUCCESS")
										d.resolve(execRes.message);

									//update parameters and plugins.json conf file
									try {

										var plugin_folder = PLUGINS_STORE + plugin_name;
										var schema_outputFilename = plugin_folder + "/" + plugin_name + '.json';

										fs.writeFile(schema_outputFilename, plugin_json, function (err) {

											if (err) {

												logger.error('[PLUGIN] --> Error parsing ' + plugin_name + '.json file: ' + err);

											} else {

												logger.debug('[PLUGIN] --> Plugin JSON schema saved to ' + schema_outputFilename);

												try {

													//Reading the plugin configuration file
													var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));

													// - change the plugin status from "off" to "on" and update the PID value
													pluginsConf.plugins[plugin_name].status = "off";
													pluginsConf.plugins[plugin_name].pid = "";

													//updates the JSON file
													fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function (err) {

														if (err) {
															logger.error('[PLUGIN] --> Error writing plugins.json file: ' + err);
														} else {
															logger.debug("[PLUGIN] --> JSON file plugins.json updated -> " + plugin_name + ':  status < ' + pluginsConf.plugins[plugin_name].status + ' > ' + pluginsConf.plugins[plugin_name].pid);
														}

													});

												} catch (err) {
													logger.error('Error updating JSON file plugins.json: ' + JSON.stringify(err));
												}


											}

										});


									} catch (err) {
										logger.error('Error updating JSON file plugins.json: ' + JSON.stringify(err));
									}


								}
							);


							break;

						default:

							response.result = "ERROR";
							response.message = 'Wrong plugin type: ' + plugin_type;
							logger.warn("[PLUGIN] - '" + plugin_name + "' plugin execution error: " + response.message);
							d.resolve(response);

							break;

					}


				}
				else {

					response.result = "ERROR";
					response.message = "Sync plugin '" + plugin_name + "' already started on board '" + boardCode + "'!";
					logger.warn("[PLUGIN] --> " + response.message);
					d.resolve(response);
				}

			}
			else {
				// Here the plugin does not exist
				response.result = "ERROR";
				response.message = "Sync plugin '" + plugin_name + "' does not exist on board '" + boardCode + "'!";
				logger.error("[PLUGIN] --> " + response.message);
				d.resolve(response);
			}

		}
		else {
			response.result = "ERROR";
			response.message = 'Checksum plugin error!';
			logger.error("[PLUGIN] - '" + plugin_name + "' plugin execution error on board '" + boardCode + "': " + response.message);
			d.resolve(response);
		}

	}
	catch(err){
		response.result = "ERROR";
		response.message = JSON.stringify(err);
		logger.error('[PLUGIN] - "' + plugin_name + '" plugin call error: '+response.message);
		d.resolve(response);
	}
	
	return d.promise;
};


// RPC to check if the plugin has to be restarted
exports.pluginKeepAlive = function (plugin_name, plugin_checksum){
   
    try{
	  
		// Get the plugin's configuration.
		var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));

		var status = pluginsConf.plugins[plugin_name].status;
		var autostart = pluginsConf.plugins[plugin_name].autostart;

		var plugin_folder = PLUGINS_STORE + plugin_name;
		var plugin_json_name = plugin_folder + "/" + plugin_name + '.json';

		var skip = "false";

		// We have to restart only the plugins:
		// - that the "autostart" flag is TRUE (boot enabled plugin)
		// - that were in status "on" (it means that the device it was rebooted or LR crashed) even if "autostart" is FALSE
	  	if (status == "on" || autostart == "true"){

			// We associate to each plugin that has to be restarted (no injected ones) a timer to check during LR execution if the plugin is still alive
			if(status != "injected"){

				/*
					We have to verify this "injected" status condition because of when a plugin is just injected, with "autostart" set at true, has the following configuration:
						"PLUGIN": {
							"status": "injected",
							"autostart": "true"
						}

				*/

				// BUT we call NOW "pluginStarter" in order to start immediately the plugins that have to be, with "timer" parameter set to null,
				// so in this way we don't wait for the timer expiration 
				pluginStarter(plugin_name, null, plugin_json_name, skip, plugin_checksum);
		
		  		var timer = setInterval(function() {
		    
		      		pluginStarter(plugin_name, timer, plugin_json_name, skip, plugin_checksum);

		  		}, alive_timer * 1000);  //LR checks if the plugin is alive

		  		plugins[plugin_name]={
					child: "",
					pid: "",
					alive: "",
					timer: timer
			  	}
		  
	      	}
	      
	  	}

	  
    }
    catch(err){
		logger.error('Error in keeping alive the plugin "'+plugin_name+'": '+ err);
    }


};


// RPC to restart all enabled plugins at LR boot
exports.pluginsBootLoader = function (){
  
    logger.info('[PLUGIN] - Plugins Boot Loader is running!');

	PLUGIN_MODULE_LOADED = true;

	var injected_num = 0;

	try{

		// Get the plugin's configuration.
		var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));

		// Get the plugin json object list
		var plugins_keys = Object.keys( pluginsConf["plugins"] );

		// Get the number of plugins in the list "plugins_keys" in order to use it in the next loop
		var plugin_num = plugins_keys.length;
		logger.info('[PLUGIN] - Number of installed plugins: '+ plugin_num);

		if(plugin_num > 0) {

			var enabledPlugins = { "plugins":{} };

			for (var i = 0; i < plugin_num; i++) {

				(function (i) {

					var plugin_name = plugins_keys[i];
					var status = pluginsConf.plugins[plugin_name].status;
					var autostart = pluginsConf.plugins[plugin_name].autostart;

					var iotronic_dep = pluginsConf.plugins[plugin_name].iotronic_dep;
					var on_maintenance = pluginsConf.plugins[plugin_name].on_maintenance;


					if(status != "injected"){

						// LR has to restart only the plugins:
						// - that the "autostart" flag is TRUE (boot enabled plugin)
						// - that were in status "on" (it means that the device it was rebooted or LR crashed) even if "autostart" is FALSE
						if (status == "on" || autostart == "true"){

							if(iotronic_dep == "false"){
								enabledPlugins.plugins[plugin_name] = pluginsConf.plugins[plugin_name];

								if(on_maintenance == "false"){
									nonMaintenancePlugins.plugins[plugin_name] = pluginsConf.plugins[plugin_name];
								}
							}

						}

					}
					else{
						injected_num = injected_num + 1;
					}

					if(i == plugin_num - 1){

						var enabled_keys = Object.keys( enabledPlugins["plugins"] );
						var enabled_num = enabled_keys.length;

						logger.info('[PLUGIN] --> Number of enabled plugins: '+ enabled_num);
						logger.info('[PLUGIN] --> Number of injected plugins: '+ injected_num);

						if(enabled_num > 0) {

							logger.info('[PLUGIN] - Starting enabled plugins on the device: ');

							for (var i = 0; i < enabled_num; i++) {

								(function (i) {

									var plugin_name = enabled_keys[i];
									var status = enabledPlugins.plugins[plugin_name].status;
									var autostart = enabledPlugins.plugins[plugin_name].autostart;
									var plugin_type = enabledPlugins.plugins[plugin_name].type;
									var category = enabledPlugins.plugins[plugin_name].category;

									if(plugin_type == "nodejs")
										var ext = '.js';
									else if(plugin_type == "python")
										var ext ='.py';


									logger.info('[PLUGIN] |--> ' + plugin_name + ' ['+category+'] - status: ' + status + ' - autostart: ' + autostart);

									setTimeout(function () {

										var category = pluginsConf.plugins[plugin_name].category;

										var plugin_checksum = CHECKSUMS_PLUGINS_LIST[plugin_name]; //if LR will start without connection to Iotronic this value will be "undefined"

										if (category == "async"){
											exports.pluginKeepAlive(plugin_name, plugin_checksum);

										}
										else if (category == "sync"){

											var plugin_json_name = PLUGINS_STORE + plugin_name + "/" + plugin_name + '.json';
											var plugin_json_schema = fs.readFileSync(plugin_json_name, 'utf8');
											exports.call([plugin_name, plugin_json_schema, plugin_checksum]);

										}
										else{
											logger.warn("[PLUGIN] - Plugin '"+plugin_name+"' without category!")
										}

									}, 7000 * i);


								})(i);

							}

						}


					}



				})(i);

			}


		}
		else{
			logger.info('[PLUGIN] - No enabled plugins to be restarted!');
		}
		

	}
	catch(err){
		logger.warn('[PLUGIN] - Error parsing plugins.json: '+ err);
	}


};


// RPC to restart all enabled plugins at LR startup...moreover associates a timer with each plugin to check if the plugin process is alive
exports.pluginsLoader = function (){

	logger.info('[PLUGIN] - Plugins Loader is running!');
	
	try{

		// Get plugins checksum from Iotronic
		session_plugins.call('s4t.iotronic.plugin.checksum', [boardCode]).then(

			function (rpc_response) {

				if (rpc_response.result == "ERROR") {

					logger.error("[PLUGIN] --> Getting plugin checksum list failed: " + rpc_response.message);

				}
				else {

					CHECKSUMS_PLUGINS_LIST = rpc_response.message;
					logger.info("[PLUGIN] --> Plugins checksum list recovered!");

					var injected_num = 0;
					var maintenance_num = 0;

					try{

						// Get the plugin's configuration.
						var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));

						try{

							// Get the plugin json object list
							var plugins_keys = Object.keys( pluginsConf["plugins"] );

							// Get the number of plugins in the list "plugins_keys" in order to use it in the next loop
							var plugin_num = plugins_keys.length;
							logger.info('[PLUGIN] --> Number of installed plugins: '+ plugin_num);

							if(plugin_num > 0) {

								var enabledPlugins = { "plugins":{} };

								for (var i = 0; i < plugin_num; i++) {

									(function (i) {

										var plugin_name = plugins_keys[i];
										var status = pluginsConf.plugins[plugin_name].status;
										var autostart = pluginsConf.plugins[plugin_name].autostart;

										var on_maintenance = pluginsConf.plugins[plugin_name].on_maintenance;

										if(status != "injected"){

											// We have to restart only the plugins:
											// - that the "autostart" flag is TRUE (boot enabled plugin)
											// - that were in status "on" (it means that the device it was rebooted or LR crashed) even if "autostart" is FALSE
											if (status == "on" || autostart == "true"){

												if( lyt_device.state != "maintenance"){

													enabledPlugins.plugins[plugin_name] = pluginsConf.plugins[plugin_name];

												}
												else{
													// LR is in MAINTENANCE
													if (on_maintenance == "true") {
														enabledPlugins.plugins[plugin_name] = pluginsConf.plugins[plugin_name];
														maintenance_num = maintenance_num + 1;
													}
													else{
														nonMaintenancePlugins.plugins[plugin_name] = pluginsConf.plugins[plugin_name];
													}
												}

											}

										}
										else{
											injected_num = injected_num + 1;
										}


										if(i == plugin_num-1){

											var enabled_keys = Object.keys( enabledPlugins["plugins"] );
											var enabled_num = enabled_keys.length;

											logger.info('[PLUGIN] --> Number of enabled plugins: '+ enabled_num);
											logger.info('[PLUGIN] --> Number of injected plugins: '+ injected_num);


											// Kill plugins with on_maintenance = "false"
											var nonManPlg_keys = Object.keys( nonMaintenancePlugins["plugins"] );
											var nonManPlg_num = nonManPlg_keys.length;


											if (nonManPlg_num > 0 && lyt_device.state == "maintenance"){
												logger.info('[PLUGIN] --> Number of maintenance plugins: '+ maintenance_num);

												logger.info('[PLUGIN] - Killing non-maintenance plugins on the device: ');
												for (var i = 0; i < nonManPlg_num; i++) {

													(function (i) {

														var plugin_name = nonManPlg_keys[i];

														logger.info('[PLUGIN] |--> ' + plugin_name);

														setTimeout(function () {

															exports.kill([plugin_name]).then(
																function (response) {

																	if(response != "ERROR"){

																		if (response.result == "SUCCESS")
																			logger.info("[PLUGIN] --> Non-maintenance plugin '" + plugin_name + "' killed.");
																		else if(response.code == "NO-RUN")
																			logger.info("[PLUGIN] --> Non-maintenance plugin '" + plugin_name + "' not running.");

																		var iotronic_plugin_status = "killed";
																		var version = nonMaintenancePlugins["plugins"][plugin_name].version;

																		try{

																			session_plugins.call('s4t.iotronic.plugin.updateStatus', [boardCode, plugin_name, version, iotronic_plugin_status]).then(
																				function (rpc_response) {

																					if (rpc_response.result == "ERROR") {

																						logger.error("[PLUGIN] --> Error notification plugin status for '" + plugin_name + "' plugin: " + rpc_response.message);

																					} else {

																						logger.info("[PLUGIN] - plugin '" + plugin_name + "': Iotronic status updated to '" + iotronic_plugin_status +"'" );

																					}

																				}
																			);
																		}
																		catch(err){

																			response.result = "ERROR";

																			if(session_plugins == null){
																				response.message = 'update plugin status error: no Iotronic session established!';
																				logger.warn('[PLUGIN] - '+plugin_name + ' - '+response.message);
																			}
																			else{
																				response.message = 'update plugin status error: ' + err;
																				logger.error('[PLUGIN] - '+plugin_name + ' - '+response.message);
																			}

																		}


																		if(i == nonManPlg_num - 1){

																			exports.startEnabledPlg([enabledPlugins, pluginsConf]);

																		}

																	}
																	else
																		logger.warn("[PLUGIN] --> Error killing plugin '" + plugin_name + "'");

																}
															);

														}, 1000 * i);


													})(i);

												}


											}
											else{
												exports.startEnabledPlg([enabledPlugins, pluginsConf]);
											}


										}



									})(i);

								}


							}
							else{
								logger.info('[PLUGIN] --> No enabled plugins to be restarted!');
							}

						}
						catch(err){
							logger.warn('[PLUGIN] --> Error starting plugins at boot: '+ err);

						}

					}
					catch(err){

						logger.warn('[PLUGIN] --> Error parsing plugins.json: '+ err);

						session_plugins.call("s4t.iotronic.plugin.getPLuginsConfs", [boardCode]).then(

							function(plgConf){

								if(plgConf.result == "SUCCESS"){

									exports.updatePluginConf([plgConf]).then(
										function (plgConf) {
											if (plgConf.result == "SUCCESS"){

												logger.warn("LR restarting in 5 seconds");

												// activate listener on-exit event after LR exit on-update-conf
												process.on("exit", function () {

													require("child_process").spawn(process.argv.shift(), process.argv, {
														cwd: process.cwd(),
														detached: true,
														stdio: "inherit"
													});

												});

												//Restarting LR
												setTimeout(function () {

													process.exit();

												}, 5000);

											}
											else
												logger.warn("[PLUGIN] - Error wrinting plugin.json: " + plgConf.message);

										}
									);

								}
								else
									logger.error('[PLUGIN] --> Error getting plugins.json from Iotronic: '+ response.message);

							}

						);

					}


				}

			}

		);


	}
	catch(err){
		logger.warn('[PLUGIN-CONNECTION-RECOVERY] - Error calling "s4t.iotronic.isAlive"');
	}


};

exports.startEnabledPlg = function(args){

	var enabledPlugins = args[0];
	var pluginsConf = args[1];

	logger.info('[PLUGIN] - Starting enabled plugins on the device: ');

	try{

		var enabled_keys = Object.keys( enabledPlugins["plugins"] );
		var enabled_num = enabled_keys.length;

		for (var i = 0; i < enabled_num; i++) {

			(function (i) {

				var plugin_name = enabled_keys[i];
				var status = enabledPlugins.plugins[plugin_name].status;
				var autostart = enabledPlugins.plugins[plugin_name].autostart;
				var plugin_type = enabledPlugins.plugins[plugin_name].type;
				var plugin_version = enabledPlugins.plugins[plugin_name].version;
				var category = enabledPlugins.plugins[plugin_name].category;


				if(plugin_type == "nodejs")
					var ext = '.js';
				else if(plugin_type == "python")
					var ext ='.py';

				var checksum = md5(	fs.readFileSync(PLUGINS_STORE + plugin_name + "/"+plugin_name+ext, 'utf8'));
				var plugin_checksum = CHECKSUMS_PLUGINS_LIST[plugin_name];

				if(plugin_checksum == checksum){

					logger.info('[PLUGIN] |--> ' + plugin_name + ' ['+category+'] - status: ' + status + ' - autostart: ' + autostart);

					setTimeout(function () {

						var category = pluginsConf.plugins[plugin_name].category;

						if (category == undefined){

							logger.warn("[PLUGIN] - Plugin '"+plugin_name+"' without category!");

							session_plugins.call("s4t.iotronic.plugin.getPLuginsConfs", [boardCode]).then(

								function(plgConf){

									if(plgConf.result == "SUCCESS"){

										remote_plugins_conf = plgConf.message;

										pluginsConf.plugins[plugin_name] = remote_plugins_conf.plugins[plugin_name];

										fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function(err) {

											if(err) {

												logger.error('[PLUGIN] --> "'+ plugin_name + '" - Error opening '+plugin_name+'.json file: ' + err);

											}
											else {

												logger.info("[PLUGIN] --> category updated for plugin '"+ plugin_name +"'");

												category = pluginsConf.plugins[plugin_name].category;

												// START PLUGIN
												if (category == "async"){
													exports.pluginKeepAlive(plugin_name, plugin_checksum);

												}
												else if (category == "sync"){

													var plugin_json_name = PLUGINS_STORE + plugin_name + "/" + plugin_name + '.json';
													var plugin_json_schema = fs.readFileSync(plugin_json_name, 'utf8');
													exports.call([plugin_name, plugin_json_schema, plugin_checksum]);

												}


											}

										});

									}
									else
										logger.error('[PLUGIN] --> Error getting plugins.json from Iotronic: '+ response.message);

								}

							);


						}
						else{

							if (category == "async"){
								exports.pluginKeepAlive(plugin_name, plugin_checksum);

							}
							else if (category == "sync"){

								var plugin_json_name = PLUGINS_STORE + plugin_name + "/" + plugin_name + '.json';
								var plugin_json_schema = fs.readFileSync(plugin_json_name, 'utf8');
								exports.call([plugin_name, plugin_json_schema, plugin_checksum]);

							}
						}





					}, 7000 * i);


				}
				else{

					logger.warn('[PLUGIN] |--> ' + plugin_name + ' - checksums mismatch: ' + checksum + ' - correct checksum: ' + plugin_checksum);

					session_plugins.call('s4t.iotronic.plugin.invalidPlugin', [boardCode, plugin_name, plugin_version]).then(

						function (rpc_response) {

							if (rpc_response.result == "ERROR") {

								logger.error("[PLUGIN] --> Error notification plugin checksum mismatch for '" + plugin_name + "' plugin: " + rpc_response.message);

							}
							else {

								logger.debug("[PLUGIN] - Invalidation plugin response: " + rpc_response.message);

							}

						}
					);


				}

			})(i);

		}

	}
	catch(err){
		logger.warn('[PLUGIN] - Error parsing plugins.json: '+ err);
	}


};



// RPC to restart all enabled plugins at LR boot
exports.pluginsReloader = function (){

	logger.info('[PLUGIN] - Plugins Reloader is running!');

	//PLUGIN_MODULE_LOADED = true;

	var injected_num = 0;
	var maintenance_num = 0;

	try{

		// Get the plugin's configuration.
		var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));

		// Get the plugin json object list
		var plugins_keys = Object.keys( pluginsConf["plugins"] );

		// Get the number of plugins in the list "plugins_keys" in order to use it in the next loop
		var plugin_num = plugins_keys.length;
		logger.info('[PLUGIN] - Number of installed plugins: '+ plugin_num);

		if(plugin_num > 0) {

			var enabledPlugins = { "plugins":{} };

			for (var i = 0; i < plugin_num; i++) {

				(function (i) {

					var plugin_name = plugins_keys[i];
					var status = pluginsConf.plugins[plugin_name].status;
					var autostart = pluginsConf.plugins[plugin_name].autostart;

					var iotronic_dep = pluginsConf.plugins[plugin_name].iotronic_dep;
					var on_maintenance = pluginsConf.plugins[plugin_name].on_maintenance;

					var plugin_version = pluginsConf.plugins[plugin_name].version;

					// LR has to restart only the plugins with:
					// - "autostart" flag is TRUE (boot enabled plugin)
					// - "status" is not "injected"
					// - "iotronic_dep" is "true"
					if(status != "injected") {

						if (autostart == "true" && iotronic_dep == "true") {

							if (lyt_device.state != "maintenance")
								enabledPlugins.plugins[plugin_name] = pluginsConf.plugins[plugin_name];
							else {
								// LR is in MAINTENANCE
								if (on_maintenance == "true") {
									enabledPlugins.plugins[plugin_name] = pluginsConf.plugins[plugin_name];
									maintenance_num = maintenance_num + 1;
								}
							}

						}

						if (autostart == "true"){

							iotronic_plugin_status = "no-conn-start";
							session_plugins.call('s4t.iotronic.plugin.updateStatus', [boardCode, plugin_name, plugin_version, iotronic_plugin_status]).then(

								function (rpc_response) {

									if (rpc_response.result == "ERROR") {
										logger.error("[PLUGIN] --> Error notification plugin status for '" + plugin_name + "' plugin: " + rpc_response.message);
									}
									else {
										logger.debug("[PLUGIN] - Iotronic updating status response: " + rpc_response.message);
										logger.info("[PLUGIN] - Plugin '"+plugin_name + "' status updated in Iotronic to " + iotronic_plugin_status);
									}

								}
							);

						}
						
					}
					else{
						injected_num = injected_num + 1;
					}

					if(i == plugin_num - 1){

						var enabled_keys = Object.keys( enabledPlugins["plugins"] );
						var enabled_num = enabled_keys.length;

						logger.info('[PLUGIN] --> Number of enabled plugins: '+ enabled_num);
						logger.info('[PLUGIN] --> Number of injected plugins: '+ injected_num);
						if (lyt_device.state == "maintenance")
							logger.info('[PLUGIN] --> Number of maintenance plugins: '+ maintenance_num);


						// Kill plugins with on_maintenance = "false"
						var nonManPlg_keys = Object.keys( nonMaintenancePlugins["plugins"] );
						var nonManPlg_num = nonManPlg_keys.length;

						if(nonManPlg_num > 0 && lyt_device.state == "maintenance") {

							logger.info('[PLUGIN] - Killing non-maintenance plugins on the device: ');
							for (var i = 0; i < nonManPlg_num; i++) {

								(function (i) {

									var plugin_name = nonManPlg_keys[i];

									logger.info('[PLUGIN] |--> ' + plugin_name);

									setTimeout(function () {

										exports.kill([plugin_name]).then(
											function (response) {
												if (response.result == "SUCCESS" || response.code == "NO-RUN"){

													logger.info("[PLUGIN] - Non-maintenance plugin '" + plugin_name + "' killed.");

													var iotronic_plugin_status = "killed";
													var version = nonMaintenancePlugins["plugins"][plugin_name].version;

													try{

														session_plugins.call('s4t.iotronic.plugin.updateStatus', [boardCode, plugin_name, version, iotronic_plugin_status]).then(
															function (rpc_response) {

																if (rpc_response.result == "ERROR") {

																	logger.error("[PLUGIN] --> Error notification plugin status for '" + plugin_name + "' plugin: " + rpc_response.message);

																} else {

																	logger.info("[PLUGIN] - plugin '" + plugin_name + "': Iotronic status updated to '" + iotronic_plugin_status +"'" );

																}

															}
														);
													}
													catch(err){

														response.result = "ERROR";

														if(session_plugins == null){
															response.message = 'update plugin status error: no Iotronic session established!';
															logger.warn('[PLUGIN] - '+plugin_name + ' - '+response.message);
														}
														else{
															response.message = 'update plugin status error: ' + err;
															logger.error('[PLUGIN] - '+plugin_name + ' - '+response.message);
														}

													}


													if(i == nonManPlg_num - 1){

														exports.reloadEnabledPlg([enabledPlugins, pluginsConf]);

													}



												}
												else
													logger.warn("[PLUGIN] - Error killing plugin '" + plugin_name + "'");
											}
										);

									}, 1000 * i);


								})(i);

							}

						}
						else
							exports.reloadEnabledPlg([enabledPlugins, pluginsConf]);


					}



				})(i);

			}


		}
		else{
			logger.info('[PLUGIN] - No enabled plugins to be restarted!');
		}


	}
	catch(err){
		logger.warn('[PLUGIN] - Error parsing plugins.json: '+ err);
	}


};

exports.reloadEnabledPlg = function(args){

	var enabledPlugins = args[0];
	var pluginsConf = args[1];

	logger.info('[PLUGIN] - Starting enabled plugins on the device: ');

	try{

		var enabled_keys = Object.keys( enabledPlugins["plugins"] );
		var enabled_num = enabled_keys.length;

		for (var i = 0; i < enabled_num; i++) {

			(function (i) {

				var plugin_name = enabled_keys[i];
				var status = enabledPlugins.plugins[plugin_name].status;
				var autostart = enabledPlugins.plugins[plugin_name].autostart;
				var plugin_type = enabledPlugins.plugins[plugin_name].type;
				var category = enabledPlugins.plugins[plugin_name].category;

				if(plugin_type == "nodejs")
					var ext = '.js';
				else if(plugin_type == "python")
					var ext ='.py';

				logger.info('[PLUGIN] |--> ' + plugin_name + ' ['+category+'] - status: ' + status + ' - autostart: ' + autostart);

				setTimeout(function () {

					var category = pluginsConf.plugins[plugin_name].category;

					var plugin_checksum = CHECKSUMS_PLUGINS_LIST[plugin_name]; //if LR will start without connection to Iotronic this value will be "undefined"

					if (category == undefined){

						logger.warn("[PLUGIN] - Plugin '"+plugin_name+"' without category!");

						session_plugins.call("s4t.iotronic.plugin.getPLuginsConfs", [boardCode]).then(

							function(plgConf){

								if(plgConf.result == "SUCCESS"){

									remote_plugins_conf = plgConf.message;

									pluginsConf.plugins[plugin_name] = remote_plugins_conf.plugins[plugin_name];

									fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function(err) {

										if(err) {

											logger.error('[PLUGIN] --> "'+ plugin_name + '" - Error opening '+plugin_name+'.json file: ' + err);

										}
										else {

											logger.info("[PLUGIN] --> category updated for plugin '"+ plugin_name +"'");

											category = pluginsConf.plugins[plugin_name].category;

											// START PLUGIN
											if (category == "async"){

												exports.pluginKeepAlive(plugin_name, plugin_checksum);

											}
											else if (category == "sync"){

												var plugin_json_name = PLUGINS_STORE + plugin_name + "/" + plugin_name + '.json';
												var plugin_json_schema = fs.readFileSync(plugin_json_name, 'utf8');
												exports.call([plugin_name, plugin_json_schema, plugin_checksum]);

											}


										}

									});

								}
								else
									logger.error('[PLUGIN] --> Error getting plugins.json from Iotronic: '+ response.message);

							}

						);


					}
					else{

						if (category == "async"){

							exports.pluginKeepAlive(plugin_name, plugin_checksum);

						}
						else if (category == "sync"){

							var plugin_json_name = PLUGINS_STORE + plugin_name + "/" + plugin_name + '.json';
							var plugin_json_schema = fs.readFileSync(plugin_json_name, 'utf8');
							exports.call([plugin_name, plugin_json_schema, plugin_checksum]);

						}

					}


				}, 7000 * i);


			})(i);

		}

	}
	catch(err){
		logger.warn('[PLUGIN] - Error parsing plugins.json: '+ err);
	}


};



// RPC to put in running an asynchronous plugin in a new process: it is called by Iotronic via RPC
exports.run = function (args){

	var d = Q.defer();

	var response = {
		message: '',
		result: ''
	};

	try{

		//Parsing the input arguments
		var plugin_name = String(args[0]);
		var plugin_json = String(args[1]);
		var plugin_checksum = String(args[2]);

		CHECKSUMS_PLUGINS_LIST[plugin_name] = plugin_checksum;

		// The autostart parameter at RUN stage is OPTIONAL. It is used at this stage if the user needs to change the boot execution configuration of the plugin after the INJECTION stage.
		var plugin_autostart = "";

		logger.info('[PLUGIN] - Async plugin RPC called for plugin "'+ plugin_name +'" plugin...');
		logger.info("[PLUGIN] --> Input parameters:\n"+ plugin_json);

		//Reading the plugin configuration file
		var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));

		var status = pluginsConf.plugins[plugin_name].status;
		var plugin_type = pluginsConf.plugins[plugin_name].type;


		if(plugin_type == "nodejs")
			var ext = '.js';
		else if(plugin_type == "python")
			var ext ='.py';


		var checksum = md5(	fs.readFileSync(PLUGINS_STORE + plugin_name + "/"+plugin_name+ext, 'utf8'));

		if(checksum === plugin_checksum){

			//If the plugin exists
			if(pluginsConf["plugins"].hasOwnProperty(plugin_name)){

				logger.debug('[PLUGIN] - '+ plugin_name + ' - Plugin configuration successfully loaded!');

				//Check the status
				var status = pluginsConf.plugins[plugin_name].status;
				var version = pluginsConf.plugins[plugin_name].version;

				if (status == "off" || status == "injected" ){

					//UPDATE PLUGIN MANAGEMENT
					if (status == "injected"){

						if (pluginsConf.plugins[plugin_name].pid != undefined){

							var pid = pluginsConf.plugins[plugin_name].pid;

							// if the plugin is not running the pid is NULL or "", in this condition "is-running" module return "true" that is a WRONG result!
							if (pid != null && pid != ""){

								if (running(pid) == true) {

									try{

										process.kill(pid);

										logger.warn("[PLUGIN] - A previous plugin instance was killed: '"+plugin_name+"' [" + pid + "]");

										clearPluginTimer(plugin_name);
										logger.warn("[PLUGIN] --> '"+plugin_name+"' plugin timer monitor cleared!");


									}
									catch(err){

										logger.error("[PLUGIN] - Error killing previous plugin instance [" + pid + "]: " + err);
									}

								}

							}

						}

					}


					logger.info('[PLUGIN] - '+ plugin_name + ' - Plugin starting...');


					//set plugin logger
					var api = require(LIGHTNINGROD_HOME + '/modules/plugins-manager/nodejs/plugin-apis');

					if(PLUGIN_LOGGERS[plugin_name] == undefined){
						PLUGIN_LOGGERS[plugin_name] = api.getLogger(plugin_name, 'debug');
					}

					// Check the plugin type: "nodejs" or "python"
					switch (plugin_type) {

						case 'nodejs':

							//Create a new process that has wrapper that manages the plugin execution
							var child = cp.fork(LIGHTNINGROD_HOME + '/modules/plugins-manager/nodejs/async-wrapper', {
								silent: true,
							});

							//Prepare the message I will send to the process with name of the plugin to start and json file as argument
							var input_message = {
								"plugin_name": plugin_name,
								"plugin_json": JSON.parse(plugin_json)
							};

							child.on('message', function(msg) {

								if(msg.name != undefined){

									if (msg.status === "alive"){

										//Creating the plugin json schema
										var plugin_folder = PLUGINS_STORE + plugin_name;
										var schema_outputFilename = plugin_folder + "/" + plugin_name + '.json';

										fs.writeFile(schema_outputFilename, plugin_json, function(err) {

											if(err) {
												response.result = "ERROR";
												response.message = 'Error opening '+plugin_name+'.json file: ' + err;
												logger.error('[PLUGIN] - "'+plugin_name + '" - '+response.message);
												d.resolve(response);

											} else {

												logger.info('[PLUGIN] - '+ plugin_name + ' - Plugin JSON schema saved to ' + schema_outputFilename);

												// Reading the plugins.json configuration file
												try{

													var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));
													var pluginsSchemaConf = JSON.parse(fs.readFileSync(schema_outputFilename, 'utf8'));

													//Get the autostart parameter from the schema just uploaded
													plugin_autostart = pluginsSchemaConf.autostart;


												}
												catch(err){

													response.result = "ERROR";
													response.message = 'Error parsing plugins.json configuration file: ' + err;
													logger.error('[PLUGIN] - '+plugin_name + ' - '+response.message);

													d.resolve(response);

												}

												// Updating the plugins.json file:
												// - check if the user changed the autostart parameter at this stage
												if(plugin_autostart != undefined){

													pluginsConf.plugins[plugin_name].autostart = plugin_autostart;
													logger.info('[PLUGIN] - '+ plugin_name + ' - Autostart parameter set by user to ' + plugin_autostart);

												} else {

													logger.info('[PLUGIN] - '+ plugin_name + ' - Autostart parameter not changed!');

												}

												// - change the plugin status from "off" to "on" and update the PID value
												pluginsConf.plugins[plugin_name].status = "on";
												pluginsConf.plugins[plugin_name].pid = child.pid;

												fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function(err) {

													if(err) {
														logger.error('[PLUGIN] - '+ plugin_name + ' - Error opening '+plugin_name+'.json file: ' + err);
													} else {
														logger.info('[PLUGIN] - '+ plugin_name + ' - plugins.json updated -> autostart < ' + pluginsConf.plugins[plugin_name].autostart + ' > - status < '+ pluginsConf.plugins[plugin_name].status + ' > ' + pluginsConf.plugins[plugin_name].pid);

														// Start a timer to check every X minutes if the plugin is still alive!
														exports.pluginKeepAlive(plugin_name, plugin_checksum, null);

													}

												});

											}

										});


									}
									else if(msg.level === "error") {

										logger.error("[PLUGIN] - "+ msg.name + " - " + msg.logmsg);

									} else if(msg.level === "warn") {

										logger.warn("[PLUGIN] - "+ msg.name + " - " + msg.logmsg);

										if(msg.status === "failed"){

											// if plugin crashes

											logger.error("[PLUGIN] - '"+ plugin_name + "' - plugin process failed: "+ msg.name + " - " + msg.logmsg);

											clearPluginTimer(plugin_name);

											iotronic_plugin_status = "failed";
											session_plugins.call('s4t.iotronic.plugin.updateStatus', [boardCode, plugin_name, version, iotronic_plugin_status]).then(

												function (rpc_response) {

													if (rpc_response.result == "ERROR") {

														response.result = "ERROR";
														response.message = 'Error notification plugin status: '+ rpc_response.message;
														logger.error("[PLUGIN] --> Error notification plugin status for '" + plugin_name + "' plugin: " + rpc_response.message);

													}
													else {

														logger.debug("[PLUGIN] - Iotronic updating status response: " + rpc_response.message);

														response.result = "SUCCESS";
														response.message = 'Plugin environment cleaned and Iotronic status updated to ' + iotronic_plugin_status;
														logger.info("[PLUGIN] - plugin '"+plugin_name + "': "+response.message);

													}

												}
											);

										}

									} else{

										logger.info("[PLUGIN] - "+ msg.name + " - " + msg.logmsg);

									}

								}
								else{
									//serve per gestire il primo messaggio alla creazione del child
									logger.info("[PLUGIN] --> "+ msg);
								}


							});

							child.stderr.on('data', function(data) {

								var log_plug = data;
								PLUGIN_LOGGERS[plugin_name].warn("Plugin '"+plugin_name+"' error logs: \n" + log_plug);

							});

							//I send the input to the wrapper so that it can launch the proper plugin with the proper json file as argument
							child.send(input_message);

							response.result = "SUCCESS";
							response.message = 'Plugin is running!';
							logger.info('[PLUGIN] - '+plugin_name + ' - '+response.message);
							d.resolve(response);

							break;



						case 'python':

							pyAsyncStarter(plugin_name, plugin_json, plugin_checksum, "start", version).then(

								function (execRes) {
									d.resolve(execRes);
								}

							);

							break;


						default:

							response.result = "ERROR";
							response.message = 'Wrong plugin type: ' + plugin_type;
							logger.warn('[PLUGIN] - "' + plugin_name + '" plugin execution error: '+response.message);
							d.resolve(response);

							break;



					}




				}
				else{

					response.result = "WARNING";
					response.message = 'Plugin already started on this board!';
					logger.warn('[PLUGIN] - '+plugin_name+' - '+response.message);
					d.resolve(response);

				}

			}
			else{
				// Here the plugin does not exist

				response.result = "ERROR";
				response.message = "Plugin '" + plugin_name + "' does not exist on this board!";
				logger.warn('[PLUGIN] - '+plugin_name + ' - '+response.message);
				d.resolve(response);

			}

		}else{
			response.result = "ERROR";
			response.message = 'Checksum plugin error!';
			logger.error('[PLUGIN] - "' + plugin_name + '" plugin execution error: '+response.message);
			d.resolve(response);
		}


	}
	catch(err){
		response.result = "ERROR";
		response.message = JSON.stringify(err);
		logger.error('[PLUGIN] - "' + plugin_name + '" plugin execution error: '+response.message);
		d.resolve(response);
	}

	return d.promise;

};


// RPC to stop/kill a running asynchronous plugin: it is called by Iotronic via RPC
exports.kill = function (args){

	var d = Q.defer();

	var response = {
		message: '',
		result: ''
	};

	// Get the plugin's configuration.
    try{

		var plugin_name = String(args[0]);

		logger.info('[PLUGIN] - Stop plugin RPC called for plugin "'+ plugin_name +'"...');
      
	    var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));
	
	    if( pluginsConf["plugins"].hasOwnProperty(plugin_name) ){
      
	  		var status = pluginsConf.plugins[plugin_name].status;

	      	if (status == "on"){
		  
		  		var pid = pluginsConf.plugins[plugin_name].pid;

				logger.info('[PLUGIN] --> '+ plugin_name + ' - Plugin (with PID='+pid+') being stopped!');
		  
		  		//PLUGIN KILLING
				try{

		  			process.kill(pid);

				}
				catch(err){

					response.result = "ERROR";
					response.message = 'Error killing plugin: '+ err;
					logger.error('[PLUGIN] - stop plugin "'+plugin_name + '" error: '+response.message);
					d.resolve(response);

				}finally {

					pluginsConf.plugins[plugin_name].status = "off";
					pluginsConf.plugins[plugin_name].pid = "";

					// updates the JSON file
					fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function(err) {

						if(err) {
							clearPluginTimer(plugin_name);
							response.result = "ERROR";
							response.message = 'Error writing plugins.json: '+ err;
							logger.error('[PLUGIN] - stop plugin "'+plugin_name + '" error: '+response.message);
							d.resolve(response);
						}
						else {
							logger.debug("[PLUGIN] --> " + PLUGINS_SETTING + " updated!");
							clearPluginTimer(plugin_name);
							response.result = "SUCCESS";
							response.message = 'Plugin killed!';
							logger.info('[PLUGIN] --> stop plugin "'+plugin_name + '": '+response.message);
							d.resolve(response);
						}

					});

				}
		  
	  		}
	      	else{
				response.result = "ERROR";
				response.code = "NO-RUN";
				response.message = 'Plugin is not running on this board!';
				logger.warn('[PLUGIN] --> stop plugin '+plugin_name + ': '+response.message);
				d.resolve(response);
	  		}
	      
  		}else{
			response.result = "ERROR";
			response.message = "Plugin '" + plugin_name + "' is not injected on this board!";
			logger.error('[PLUGIN] --> stop plugin ' + plugin_name + ': '+response.message);
			d.resolve(response);
		}
    

    }
    catch(err){

		response.result = "ERROR";
		response.message = JSON.stringify(err);
		logger.error('[PLUGIN] - stopping plugin "'+plugin_name + '" error: '+response.message);
		d.resolve(response);
    }

	return d.promise;
    
};


// RPC to manage the injection request of a plugin into the device: it is called by Iotronic via RPC
exports.injectPlugin = function(args){

	var d = Q.defer();

	var response = {
		message: '',
		result: ''
	};

	try{

		// Parsing the input arguments
		var plugin_bundle = JSON.parse(args[0]);
		var autostart = String(args[1]); 		// The autostart parameter is used to set the boot execution configuration of the plugin.
		var force = String(args[2]); 			// If specified -> overwrite the plugin previously injected
		var on_maintenance = String(args[3]); 	// If true the plugin can autostart at boot also when the device is in maintenance state

		var plugin_code = plugin_bundle.code;
		var plugin_name = plugin_bundle.name;

		logger.info("[PLUGIN] - Injecting plugin RPC called for '" + plugin_name + "' plugin...");
		logger.debug("[PLUGIN] --> Parameters injected: { plugin_name : " + plugin_name + ", autostart : " + autostart + ", force : " + force + " }");
		//logger.debug("[PLUGIN] --> plugin code:\n\n" + plugin_code + "\n\n");
		logger.debug(JSON.stringify(plugin_bundle, null, "\t"));

		var plugin_folder = PLUGINS_STORE + plugin_name;

		if (plugin_bundle.type == "nodejs")
			var fileName = plugin_folder + "/" + plugin_name + '.js';
		else if (plugin_bundle.type == "python")
			var fileName = plugin_folder + "/" + plugin_name + '.py';


		//UPDATE PLUGIN MANAGEMENT
		var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));
		if (pluginsConf.plugins[plugin_name] != undefined && pluginsConf.plugins[plugin_name]['version'] != undefined) {
			var prec_v_pid = pluginsConf.plugins[plugin_name]['pid'];
		}

		cleanPluginData(plugin_name).then(
			function (clean_res) {

				if (clean_res.result == "SUCCESS") {

					clean_res.message = "plugin '" + plugin_name + "' environment is clean!";
					logger.debug("[PLUGIN] ----> " + clean_res.message);

					// plugin folder creation
					fs.mkdir(plugin_folder, function () {

						// Writing the file
						fs.writeFile(fileName, plugin_code, function (err) {

							if (err) {

								response.result = "ERROR";
								response.message = 'Error writing ' + fileName + ' file: ' + err;
								logger.error('[PLUGIN] --> ' + response.message);
								d.resolve(response);

							} else {

								//Reading the plugins configuration file
								var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));

								//Update the data structure of the plugin
								pluginsConf.plugins[plugin_name] = {};
								pluginsConf.plugins[plugin_name]['status'] = "injected";

								pluginsConf.plugins[plugin_name]['iotronic_dep'] = plugin_bundle.iotronic_dep;
								pluginsConf.plugins[plugin_name]['category'] = plugin_bundle.category;

								pluginsConf.plugins[plugin_name]['version'] = plugin_bundle.version;
								pluginsConf.plugins[plugin_name]['type'] = plugin_bundle.type;

								//UPDATE PLUGIN MANAGEMENT
								pluginsConf.plugins[plugin_name]['pid'] = prec_v_pid;

								if (autostart != undefined)
									pluginsConf.plugins[plugin_name]['autostart'] = autostart;
								else
									pluginsConf.plugins[plugin_name]['autostart'] = false;

								if (on_maintenance != undefined)
									pluginsConf.plugins[plugin_name]['on_maintenance'] = on_maintenance;
								else
									pluginsConf.plugins[plugin_name]['on_maintenance'] = false;

								//Update plugins.json config file
								fs.writeFile(PLUGINS_SETTING, JSON.stringify(pluginsConf, null, 4), function (err) {
									if (err) {

										response.result = "ERROR";
										response.message = 'Error writing plugins.json file: ' + err;
										logger.error('[PLUGIN] --> ' + response.message);
										d.resolve(response);

									} else {


										logger.debug("[PLUGIN] --> Configuration in plugins.json updated!");

										// Write default parameters for the plugin

										var plugin_folder = PLUGINS_STORE + plugin_name;
										var pluginsParamsFilename = plugin_folder + "/" + plugin_name + '.json';

										//Reading the plugins configuration file
										var pluginsParams = plugin_bundle.defaults;

										fs.writeFile(pluginsParamsFilename, JSON.stringify(JSON.parse(pluginsParams), null, 4), function (err) {
											if (err) {

												response.result = "ERROR";
												response.message = 'Error writing default parameters: ' + err;
												logger.error('[PLUGIN] --> ' + response.message);
												d.resolve(response);

											} else {
												logger.debug("[PLUGIN] --> Default parameters written!");

												response.result = "SUCCESS";
												response.message = "Plugin '" + plugin_name + "' injected successfully!";
												logger.info('[PLUGIN] --> ' + response.message);
												d.resolve(response);

											}
										});

									}
								});


							}

						});


					});

				} else {

					logger.error("[PLUGIN] --> " + clean_res.message);
					d.resolve(clean_res.message);
				}

			}
		);

	}
	catch(err){

		response.result = "ERROR";
		response.message = JSON.stringify(err);
		logger.error('[PLUGIN] - injecting plugin "'+plugin_name + '" error: '+response.message);
		d.resolve(response);
	}



    return d.promise;


    
};


// RPC to manage the removal of a plugin from the device: it is called by Iotronic via RPC
exports.removePlugin = function(args){

	var d = Q.defer();

	var response = {
		message: '',
		result: ''
	};

	try {

		// Parsing the input arguments
		var plugin_name = String(args[0]);

		logger.info("[PLUGIN] - Removing plugin RPC called for '" + plugin_name + "' plugin...");

		var plugin_folder = PLUGINS_STORE + plugin_name;

		//Reading the plugins.json configuration file
		var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));
		var pid = pluginsConf.plugins[plugin_name].pid;

		// if the plugin is not running the pid is NULL or "", in this condition "is-running" module return "true" that is a WRONG result!
		if (running(pid) == false || pid == null || pid == "") {

			if (fs.existsSync(plugin_folder) === true) {

				cleanPluginData(plugin_name).then(
					function (clean_res) {

						if (clean_res.result == "SUCCESS") {

							response.message = "Plugin '" + plugin_name + "' successfully removed!";
							response.result = clean_res.result;
							logger.info("[PLUGIN] --> " + response.message);
							d.resolve(response);

						} else {

							logger.error("[PLUGIN] --> " + clean_res.message);
							d.resolve(clean_res);

						}

					}
				);

			} else {

				response.message = "Plugin folder (" + plugin_folder + ") not found!";
				response.result = "WARNING";
				logger.warn("[PLUGIN] --> " + response.message);
				d.resolve(response);

			}


		} else {

			response.message = "Plugin '" + plugin_name + "' is still running! Please stop it before remove it from the board.";
			response.result = "WARNING";
			logger.warn("[PLUGIN] --> " + response.message);
			d.resolve(response);

		}
	}
	catch(err){
		response.result = "ERROR";
		response.message = JSON.stringify(err);
		logger.error('[PLUGIN] - Removing "' + plugin_name + '" plugin error: '+response.message);
		d.resolve(response);
	}

    return d.promise;
    
};


// RPC called to restart a plugin
exports.restartPlugin = function(args){

	var d = Q.defer();

	var response = {
		message: '',
		result: ''
	};

	try {

		var plugin_name = String(args[0]);
		var plugin_checksum = String(args[1]);

		logger.info('[PLUGIN] - Restart plugin RPC called for plugin "' + plugin_name + '" plugin...');

		// Get the plugin's configuration.
		try {

			//Reading the plugins.json configuration file
			var pluginsConf = JSON.parse(fs.readFileSync(PLUGINS_SETTING, 'utf8'));
			var plugin_type = pluginsConf.plugins[plugin_name].type;

		} catch (err) {
			response.result = "ERROR";
			response.message = 'Error parsing plugins.json!';
			logger.error('[PLUGIN] - "' + plugin_name + '" plugin execution error: ' + response.message);
			d.resolve(response);
		}

		if (plugin_type == "nodejs")
			var ext = '.js';
		else if (plugin_type == "python")
			var ext = '.py';


		var checksum = md5(fs.readFileSync(PLUGINS_STORE + plugin_name + "/" + plugin_name + ext, 'utf8'));

		if (checksum === plugin_checksum) {

			//If the plugin exists
			if (pluginsConf["plugins"].hasOwnProperty(plugin_name)) {

				exports.kill([plugin_name]).then(
					function (response) {

						if (response.result == "SUCCESS" || response.code == "NO-RUN") {

							var plugin_json_name = PLUGINS_STORE + plugin_name + "/" + plugin_name + '.json';
							var plugin_json_schema = fs.readFileSync(plugin_json_name, 'utf8');

							exports.run([plugin_name, plugin_json_schema, plugin_checksum]).then(
								function (response) {

									if (response.result == "SUCCESS") {

										response.result = "SUCCESS";
										response.message = "Plugin '" + plugin_name + "' successfully restarted";
										logger.info("[PLUGIN] - " + response.message);
										d.resolve(response);

									} else {

										response.result = "ERROR";
										response.message = "Error restarting plugin '" + plugin_name + "' during starting procedure!";
										logger.error("[PLUGIN] - " + response.message);
										d.resolve(response);

									}

								}
							);


						} else {

							console.log(response);

							response.result = "ERROR";
							response.message = "Error restarting plugin '" + plugin_name + "' during killing procedure... please retry.";
							logger.error("[PLUGIN] - " + response.message);
							d.resolve(response);

						}

					}
				);


			} else {
				// the plugin does not exist
				response.result = "ERROR";
				response.message = "Call \"" + plugin_name + "\" does not exist on this board!";
				logger.error("[PLUGIN] - " + response.message);
				d.resolve(response);
			}


		}
		else {
			response.result = "ERROR";
			response.message = 'Checksum plugin error!';
			logger.error('[PLUGIN] - "' + plugin_name + '" plugin execution error: ' + response.message);
			d.resolve(response);
		}

	}
	catch(err){
		response.result = "ERROR";
		response.message = JSON.stringify(err);
		logger.error('[PLUGIN] - Restarting "' + plugin_name + '" plugin error: '+response.message);
		d.resolve(response);
	}

	return d.promise;


};


// RPC to manage the removal of a plugin from the device: it is called by Iotronic via RPC
exports.getPluginLogs = function(args){

	var d = Q.defer();

	var response = {
		message: '',
		result: ''
	};

	try {

		// Parsing the input arguments
		var plugin_name = String(args[0]);
		var rows = String(args[1]);

		logger.info("[PLUGIN] - Getting plugin logs RPC called for '" + plugin_name + "' plugin...");

		fs.readFile('/var/log/iotronic/plugins/' + plugin_name + '.log', 'utf-8', function (err, data) {

			if (err != null) {
				response.message = 'Error retrieving plugin logs: ' + err;
				response.result = "ERROR";
				logger.warn("[PLUGIN] --> " + response.message);
				d.resolve(response);
			} else {
				var lines = data.trim().split('\n');
				var lastLine = lines.slice(-rows);

				//console.log(lastLine);

				response.message = lastLine; //"Plugin logs for '" + plugin_name + "' successfully retrieved!";
				response.result = "SUCCESS";
				logger.info("[PLUGIN] --> Plugin logs for '" + plugin_name + "' successfully retrieved!");
				d.resolve(response);
			}


		});
	}
	catch(err){
		response.result = "ERROR";
		response.message = JSON.stringify(err);
		logger.error('[PLUGIN] - getPluginLogs for "' + plugin_name + '" plugin error: '+response.message);
		d.resolve(response);
	}

	return d.promise;

};


// This function update plugins.json file injected by IoTronic
exports.updatePluginConf = function (args) {

	var d = Q.defer();

	var response = {
		message: '',
		result: ''
	};

	var remote_plugins_conf = args[0].message;

	var plugins_keys = Object.keys( remote_plugins_conf["plugins"] );
	var plugin_num = plugins_keys.length;

	//Reading the plugins.json configuration file
	var fileSettings = fs.readFileSync(PLUGINS_SETTING, 'utf8');

	try{
		var local_plugins_conf = JSON.parse(fileSettings);
	}
	catch(err) {
		fileSettings = "None";
	}

	try {




		logger.info("[SYSTEM] - Board configuration injected: " + JSON.stringify(remote_plugins_conf, null, "\t"));

		for (var i = 0; i < plugin_num; i++) {

			(function (i) {

				var plugin_name = plugins_keys[i];
				if(fileSettings != "None")
					remote_plugins_conf.plugins[plugin_name].pid = local_plugins_conf.plugins[plugin_name].pid;

				if(i==plugin_num-1){

					//Updates the plugins.json file
					fs.writeFile(PLUGINS_SETTING, JSON.stringify(remote_plugins_conf, null, "\t"), function (err) {
						if (err) {

							response.message = 'Error writing plugins.json file: ' + err;
							response.result = "ERROR";
							logger.error('[SYSTEM] --> ' + response.message);
							d.resolve(response);

						} else {

							logger.debug("[SYSTEM] --> plugins.json configuration file overwritten!");
							response.message = "Board '" + boardCode + "' plugins configuration updated: restart plugins!";
							response.result = "SUCCESS";
							d.resolve(response);

						}
					});

				}


			})(i);

		}


	}
	catch(err){
		response.result = "ERROR";
		response.message = JSON.stringify(err);
		logger.error('[SYSTEM] - updatePluginConf error: '+response.message);
		d.resolve(response);
	}

	return d.promise;

};



//This function exports all the functions in the module as WAMP remote procedure calls
exports.Init = function (session){

	session_plugins = session;

    //Register all the module functions as WAMP RPCs
    session.register('s4t.'+ boardCode+'.plugin.run', exports.run);
    session.register('s4t.'+ boardCode+'.plugin.kill', exports.kill);
    session.register('s4t.'+ boardCode+'.plugin.inject', exports.injectPlugin);
    session.register('s4t.'+ boardCode+'.plugin.call', exports.call);
	session.register('s4t.'+ boardCode+'.plugin.remove', exports.removePlugin);
	session.register('s4t.'+ boardCode+'.plugin.restart', exports.restartPlugin);
	session.register('s4t.'+ boardCode+'.plugin.logs', exports.getPluginLogs);
	session.register('s4t.'+ boardCode+'.plugin.updateConf', exports.updatePluginConf);


    logger.info('[WAMP-EXPORTS] Plugin commands exported to the cloud!');

    
};


//This function executes procedures at boot time (no Iotronic dependent)
exports.Boot = function (){

	logger.info('[BOOT] - Plugin Manager booting');
	logger.debug('[BOOT] --> plugin alive check timer: ' + alive_timer + ' seconds');

	// connectionTester: library used to check the reachability of Iotronic-Server/WAMP-Server
	var connectionTester = require('connection-tester');

	setTimeout(function(){

		var output = connectionTester.test(wampIP, port_wamp, 10000);
		var reachable = output.success;
		var error_test = output.error;

		if (!reachable) {

			//CONNECTION STATUS: FALSE
			logger.warn("[PLUGIN-CONNECTION-RECOVERY] - INTERNET CONNECTION STATUS: " + reachable + " - ERROR: " + error_test);

			exports.pluginsBootLoader();

			logger.warn( '[PLUGIN-CONNECTION-RECOVERY] - Plugins will start without checksum check!');

			checkCrossbarWampConnection = setInterval(function(){

				logger.warn("[PLUGIN-CONNECTION-RECOVERY] - RETRY...");

				connectionTester.test(wampIP, port_wamp, 10000, function (err, output) {

					var reachable = output.success;
					var error_test = output.error;

					if (!reachable) {

						//CONNECTION STATUS: FALSE
						logger.warn("[PLUGIN-CONNECTION-RECOVERY] - INTERNET CONNECTION STATUS: " + reachable + " - ERROR: " + error_test);

					}else{

						try {

							// Test if IoTronic is connected to the realm
							session_plugins.call("s4t.iotronic.isAlive", [boardCode]).then(

								function(response){

									// Get plugins checksum from Iotronic
									session_plugins.call('s4t.iotronic.plugin.checksum', [boardCode]).then(

										function (rpc_response) {

											if (rpc_response.result == "ERROR") {

												logger.error("[PLUGIN-CONNECTION-RECOVERY] --> Getting plugin checksum list failed: " + rpc_response.message);

											}
											else {

												CHECKSUMS_PLUGINS_LIST = rpc_response.message;

												logger.debug("[PLUGIN-CONNECTION-RECOVERY] --> Plugins checksums list recovered: ", CHECKSUMS_PLUGINS_LIST);

												clearInterval( checkCrossbarWampConnection );
												logger.debug("[PLUGIN-CONNECTION-RECOVERY] --> checkCrossbarWampConnection timer cleared!");

												logger.info("[PLUGIN-CONNECTION-RECOVERY] - Connection to Iotronic recovered: reloading plugins.");
												exports.pluginsReloader();

											}

										}

									);

								},
								function(err){

									logger.warn("NO WAMP CONNECTION YET!")

								}

							);

						}
						catch(err){
							logger.warn('[PLUGIN-CONNECTION-RECOVERY] - Error calling "s4t.iotronic.isAlive"');
						}


					}

				});


			}, alive_timer * 1000);


		}
		else{

			checkIotronicWampConnection = setInterval(function(){

				try {

					// Test if IoTronic is connected to the realm
					session_plugins.call("s4t.iotronic.isAlive", [boardCode]).then(

						function(response){

							exports.pluginsLoader();

							clearInterval( checkIotronicWampConnection );


						},
						function(err){

							logger.warn("[PLUGIN-CONNECTION-RECOVERY] - No WAMP connection yet!")

						}

					);

				}
				catch(err){
					logger.warn('[PLUGIN-CONNECTION-RECOVERY] - Internet connection available BUT wamp session not established!');
					logger.warn("WAMP connection error:" + err);
					if(PLUGIN_MODULE_LOADED == false){

						exports.pluginsBootLoader();

						logger.warn( '[PLUGIN-CONNECTION-RECOVERY] - Plugin will start without checksum check!');

					}

				}



			}, alive_timer * 1000);


		}


	}, 5000);


};
