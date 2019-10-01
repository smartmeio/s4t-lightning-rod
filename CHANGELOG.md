Lightning-rod v2.3.8

- Device Manager:
    - Added 'maintenance' state for device
    - Added attributes in Device class: id, state, transation_state, label
    
- Plugin Manager:
    - Fixed bug: send plugins status at boot/restart
    - Added in plugin-apis: getDeviceState(), getDeviceId(), getPosition(), disableAutostart()
    - refactored boot procedures: starting plugins device state based.
    - refactored boot procedures without connection;
    - new RPC function to recover from Iotronic plugins.json conf file if corrupted.
    




