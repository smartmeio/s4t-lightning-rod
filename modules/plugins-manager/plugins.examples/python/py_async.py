#############################################################################################
###
## Copyright (C) 2018 Nicola Peditto
###
## Licensed under the Apache License, Version 2.0 (the "License");
## you may not use this file except in compliance with the License.
## You may obtain a copy of the License at
###
## http://www.apache.org/licenses/LICENSE-2.0
###
## Unless required by applicable law or agreed to in writing, software
## distributed under the License is distributed on an "AS IS" BASIS,
## WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
## See the License for the specific language governing permissions and
## limitations under the License.
###
#############################################################################################

# User imports
import time
from datetime import datetime

#PARAMS: {"name": "S4T"}

def main(plugin_name, params, api):

   logging = api.getLogger(plugin_name)

   while(True):
        now = datetime.now().strftime( "%-d %b %Y %H:%M:%S.%f" )
        #print("I'm "+str(params['name'])+" @ "+now)
        logging.info("I'm "+str(params['name'])+" @ "+now)
        time.sleep(1)
