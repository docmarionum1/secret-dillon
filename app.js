// Require the Bolt package (github.com/slackapi/bolt)
const { App } = require("@slack/bolt");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const games = {};





app.message('new', async ({message, context, say}) => {
  if (message.channel in games) {
    say("Game already in progress!")
  }
  console.log(message);
  await app.client.chat.postMessage({
    token: context.botToken,
    channel: message.user,
    text: "You are a dillon"
  });
});


(async () => {
  // Start your app
  await app.start(process.env.PORT || 3000);

  console.log('⚡️ Bolt app is running!');
  

})();
