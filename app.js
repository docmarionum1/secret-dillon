// Require the Bolt package (github.com/slackapi/bolt)
const { App } = require("@slack/bolt");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const GAMES = {};

/**
 * Randomize array element order in-place.
 * Using Durstenfeld shuffle algorithm.
 */
function shuffleArray(array) {
    for (var i = array.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
}

const NUM_LIBBYS = {
  3: 1,
  4: 2,
  5: 3,
  6: 4,
  7: 4,
  8: 5,
  9: 5,
  10: 6
}

async function newGame(channel, user, context) { 
  // Get all users in channel
  let members = [];
  let cursor = '';
  while (true) {
    const response = await app.client.conversations.members({
      token: context.botToken,
      channel: channel,
      cursor: cursor
    });
    members = members.concat(response.members);
    cursor = response.response_metadata.next_cursor;
    if (cursor === '') break;
  }
  
  // Filter out bot user
  members = members.filter((member) => member !== context.botUserId);
  
  // Shuffle array and pick up to the first 10
  shuffleArray(members);
  const players = members.slice(0, 10);
  
  // Get a turn order
  const turnOrder = players.slice();
  shuffleArray(turnOrder);
  
  console.log(players);
  
  if (players.length < 3) {
    app.client.chat.postEphemeral({
      token: context.botToken,
      channel: channel,
      user: user,
      text: "Not enough players in the channel. A minimum of 3 is required."
    });
    return;
  }
  
  const newGame = {
    players: {},
    round: 0,
    turnOrder: turnOrder,
    manager: 0,
    step: "nominate" // nominate | vote | legislative | executive
  };
  
  async function addPlayer(player, role, message) {
    const userInfo = await app.client.users.info({
      token: context.botToken,
      user: player,
    });
    
    newGame.players[player] = {
      role: role,
      name: userInfo.user.profile.display_name,
      realName: userInfo.user.profile.real_name
    };
    
    app.client.chat.postMessage({
      token: context.botToken,
      channel: player,
      text: message
    });
  }
  
  const numDillons = players.length - NUM_LIBBYS[players.length] - 1;
  
  // Create the Dillon (captial D)
  let player = players.pop();
  await addPlayer(player, "Dillon", "You are Dillon (captial D)");
  
  // Create the dillons (lowercase d)
  for (let i = 0; i < numDillons; i++) {
    await addPlayer(players.pop(), "dillon", "You are a dillon (lowercase d)");
  }
  
  while(player = players.pop()) {
    await addPlayer(player, "libby", "You are a libby");
  }
  
  GAMES[channel] = newGame;
  console.log(GAMES);
  printStatus(channel, context);
}

async function printStatus(channel, context) {
  if (!(channel in GAMES)) {
    app.client.chat.postMessage({
      token: context.botToken,
      channel: channel,
      text: "No game running. Type `new` to start a new game."
    });
  } else {
    const game = GAMES[channel];
    
    function name(player) {
      return game.players[player].name;
    }
    
    let text = "*Players*: " + game.turnOrder.map(name).join(", ") +
              "\n*Round*: " + game.round + "\n*Step*: " + game.step;
    
    if (game.step === "nominate") {
      text += "\n*Manager Candidate*: " + name(game.turnOrder[game.manager]);
      text += "\n*Instructions*: " + name(game.turnOrder[game.manager]) + " nominate a code reviewer";
    }
    
    app.client.chat.postMessage({
      token: context.botToken,
      channel: channel,
      blocks: [
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": text
          }
        },
      ]
    });
  }
}

app.message('status', async ({message, context}) => {
  printStatus(message.channel, context);
});

app.action("new_game", async ({body, ack, respond, context}) => {
  ack();
  respond({"delete_original": true});
  newGame(body.channel.id, body.user.id, context);
});

app.message('new', async ({message, context, say}) => {
  if (message.channel in GAMES) {
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
            "action_id": "new_game",
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
    newGame(message.channel, message.user, context);
  }

});


(async () => {
  // Start your app
  await app.start(process.env.PORT || 3000);

  console.log('⚡️ Bolt app is running!');
  

})();
