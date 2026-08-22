const transport = require("./transport");

function onEvent(client, event, handler) {
  if (!client || typeof client.on !== "function") {
    throw new Error("Client does not support event listeners");
  }
  client.on(event, handler);
}

function offEvent(client, event, handler) {
  if (!client || typeof client.off !== "function") return;
  client.off(event, handler);
}

async function captureScreenshot(client, { format = "png", fullSize = false } = {}) {
  const params = { format };
  if (fullSize) {
    params.clip = undefined; // Page.captureScreenshot handles fullSize via fromSurface
    params.fromSurface = true;
  }
  const res = await transport.call(client, "Page", "captureScreenshot", params);
  return res && res.data;
}

function observeNetwork(client) {
  const responses = [];
  const onResponse = (params) => {
    if (params && params.response) {
      responses.push({
        requestId: params.requestId,
        url: params.response.url,
        status: params.response.status,
        mimeType: params.response.mimeType,
        timestamp: params.timestamp,
      });
    }
  };
  client.on("Network.responseReceived", onResponse);
  return {
    responses,
    dispose: () => client.off("Network.responseReceived", onResponse),
  };
}

module.exports = {
  onEvent,
  offEvent,
  captureScreenshot,
  observeNetwork,
};
