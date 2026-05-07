let ioInstance = null;

function setRealtimeServer(io) {
  ioInstance = io;
}

/**
 * Emite apenas para a room da loja — nunca broadcast global.
 * @param {number} lojaId
 * @param {string} eventName NEW_ORDER | ORDER_BEING_PREPARED
 * @param {object} payload
 */
function publishEvent(lojaId, eventName, payload) {
  if (!ioInstance || lojaId == null || lojaId === undefined) return;

  const room = `loja_${lojaId}`;
  ioInstance.to(room).emit('realtime-event', {
    type: eventName,
    payload,
  });

  if (eventName === 'NEW_ORDER') {
    ioInstance.to(room).emit('new-order', payload);
  }

  if (eventName === 'ORDER_BEING_PREPARED') {
    ioInstance.to(room).emit('order-being-prepared', payload);
  }
}

module.exports = {
  setRealtimeServer,
  publishEvent,
};
