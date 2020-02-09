// Require the Bolt package (github.com/slackapi/bolt)
const { App } = require("@slack/bolt");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const games = {};



async function newGame(channel, context) {
  console.log(context);
  const members = [];
  while (true) {
    const members = await app.client.conversations.members({
    token: context.botToken,
    channel: channel,
      netx
  });
  }
  
  
  console.log(members);
  // await app.client.chat.postMessage({
  //   token: context.botToken,
  //   channel: message.user,
  //   text: "You are a dillon"
  // });
}

app.message('new', async ({message, context, say}) => {
  if (message.channel in games) {
    app.client.chat.postEphemeral({
      token: context.botToken,
      channel: message.channel,
      user: message.user,
      "blocks": [
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": "A game is already in progress - are you sure you want to end the current game and start a new one?"
          },
          "accessory": {
            "type": "button",
            "text": {
              "type": "plain_text",
              "text": "New Game",
              "emoji": true
            },
            "value": "new_game",
                    "style": "danger"
          }
        }
      ]
    });
    return;
  } else {
    newGame(message.channel, context);
  }

});


(async () => {
  // Start your app
  await app.start(process.env.PORT || 3000);

  console.log('⚡️ Bolt app is running!');
  

})();
