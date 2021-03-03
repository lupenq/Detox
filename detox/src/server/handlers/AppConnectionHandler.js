const DetoxRuntimeError = require('../../errors/DetoxRuntimeError');
const RegisteredConnectionHandler = require('./RegisteredConnectionHandler');

class AppConnectionHandler extends RegisteredConnectionHandler {
  constructor({ api, session }) {
    super({ api, session, role: 'app' });
  }

  handle(action) {
    if (!this._session.tester) {
      throw new DetoxRuntimeError({
        message: 'Cannot forward the message to the Detox client.',
        debugInfo: action,
        inspectOptions: {
          depth: 3,
        }
      });
    }

    this._session.tester.sendAction(action);
  }
}

module.exports = AppConnectionHandler;
