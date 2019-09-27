import logging
import json
import os
import sys

SETTINGS_PATH = os.environ['IOTRONIC_HOME']+"/settings.json"
PLUGINS_PATH = os.environ['IOTRONIC_HOME']+"/plugins/plugins.json"

global DEVICE
DEVICE = "None"

def getLogger(plugin_name, console=None):

    # logging.root.handlers = []
    lr_format = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    logging.basicConfig(filename='/var/log/iotronic/plugins/'+plugin_name+'.log', level=logging.DEBUG)

    # set up logging to console
    if (console != None) and (console == True):
        cl = logging.StreamHandler(sys.stdout)
        cl.setLevel(logging.DEBUG)
        logging.getLogger("").addHandler(cl)

    return logging

def getExtraInfo():

    with open(SETTINGS_PATH) as settings_file:

        try:

            settings = json.load(settings_file)
            extra = settings['config']['extra']
            #print(extra)

        except Exception as err:
            extra = "NA"
            print("Error parsing settings.json: " + str(err))

        return extra


def disableAutostart(plugin_name):
    try:
        with open(PLUGINS_PATH, "r+") as jsonFile:
            data = json.load(jsonFile)

            data['plugins'][plugin_name]['autostart']='false'

            jsonFile.seek(0)
            json.dump(data, jsonFile, indent=4, sort_keys=True)
            jsonFile.truncate()

            result="disabled"
            print(result)

    except Exception as err:
        result="Error updating plugins.json: " + str(err)
        print(result)


def _setDeviceEnv(device):
    print(device)
    global DEVICE
    DEVICE = device

def getDeviceState():
    return DEVICE["state"] #"maintenance" #DEVICE_STATE

def getDeviceId():
    return DEVICE["id"] #"maintenance" #DEVICE_STATE


def getPosition():
    try:
        with open(SETTINGS_PATH) as json_file:
           settings = json.load(json_file)
           print(settings['config']['board']['position'])
           altitude = settings['config']['board']['position']['altitude']
           longitude = settings['config']['board']['position']['longitude']
           latitude = settings['config']['board']['position']['latitude']
           position = {"altitude": altitude, "longitude": longitude, "latitude": latitude}

    except Exception as err:
        logging.error("Error getting device coordinates!")
        position = {}

    return position