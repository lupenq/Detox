const { serializeError } = require('serialize-error');

class RegisteredConnectionHandler {
  constructor({ api, role, session }) {
    this._api = api;
    this._api.appendLogDetails({
      trackingId: role,
      sessionId: session.id,
      role,
    });

    /** @type {DetoxSession} */
    this._session = session;
  }

  onError(error, action) {
    if (!this._session.tester) {
      throw error;
    }

    try {
      this._session.tester.sendAction({
        type: 'error',
        params: {
          error: serializeError(error),
        },
        messageId: action && action.messageId,
      });
    } catch (err) {
      this._api.log.error('Cannot forward the error details to the tester, printing it here:\n')
      throw err;
    }
  }
}

module.exports = RegisteredConnectionHandler;
