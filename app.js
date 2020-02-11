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
  
  const game = {
    channel: channel,
    players: {},
    Dillon: "",
    dillons: [],
    libbys: [],
    //round: 0,
    turnOrder: turnOrder,
    managerIndex: 0,
    manager: turnOrder[0],
    step: "nominate", // nominate | vote | legislative | executive,
    ineligibleReviewers: [],
    reviewer: null,
    votes: {},
    promotionTracker: 0,
    deck: [],
    discard: [],
    hand: [],
    accept: 0,
    reject: 0
  };
  
  function name(player) {
    return game.players[player].name;
  }
  
  // Set up deck
  for (let i = 0; i < 6; i++) {
    game.deck.push("accept");
  }
  for (let i = 0; i < 11; i++) {
    game.deck.push("reject");
  }
  shuffleArray(game.deck);
  
  async function addPlayer(player, role) {
    const userInfo = await app.client.users.info({
      token: context.botToken,
      user: player,
    });
    
    game.players[player] = {
      role: role, // dillon | Dillon | libby
      state: "employed", // employed | fired
      name: userInfo.user.profile.display_name,
      realName: userInfo.user.profile.real_name
    };
    
    if (role === 'libby') {
      game.libbys.push(player);
    } else {
      game.dillons.push(player);
    }
  }
  
  const numDillons = players.length - NUM_LIBBYS[players.length] - 1;
  
  // Create the Dillon (captial D)
  let player = players.pop();
  game.Dillon = player;
  await addPlayer(player, "Dillon");
  
  // Create the dillons (lowercase d)
  for (let i = 0; i < numDillons; i++) {
    await addPlayer(players.pop(), "dillon");
  }
  
  while(player = players.pop()) {
    await addPlayer(player, "libby");
  }
  
  // Send a message to each player with their identity
  for (player in game.players) {
    let message = "";
    if (player.role === 'libby') {
      message =  "You are a libby";
    } else {
      if (player.role === 'dillon') {
        message = "You are a dillon (lowercase d)";
        message += `\nDillon is ${name(game.Dillon)}`;
      } else {
        message = "You are Dillon (captial D)";
      }
      
      if (player.role === 'dillon' || game.turnOrder.length <= 6) {
        message += `\nThe dillons are: ${game.dillons.map(id => name(id))}`;
      }
    }
    app.client.chat.postMessage({
      token: context.botToken,
      channel: player,
      text: message
    });
  }
  
  
  GAMES[channel] = game;
  console.log(GAMES);
  await printStatus(channel, context);
  await sendNominationForm(game, context);
}

async function sendNominationForm(game, context) {
  const eligibleReviewers = game.turnOrder.filter(player => !(player in game.ineligibleReviewers) && (player !== game.manager));
  
  app.client.chat.postMessage({
    token: context.botToken,
    channel: game.manager,
    blocks: [
      {
        type: "section",
        text: {
          "type": "mrkdwn",
          "text": "Pick a player to nominate for promotion to reviewer."
        } 
      },
      {
        "type": "divider"
      },
      {
        type: "actions",
        
        elements: eligibleReviewers.map((player, index) => {
          return {
            type: "button",
            "action_id": "nominate_" + index,
            text: {
              type: "plain_text",
              text: name(player)
            },
            "value": `${game.channel}_${player}`
          };
        })
      }
    ]
  });
}


async function printStatus(channel, context, respond) {
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
              //"\n*Round*: " + game.round + "\n*Step*: " + game.step +
              "\n*Score*: " + game.accept + " Accepted; " + game.reject + " Rejected" +
              "\n*Step*: " + game.step + 
              "\n*Cards in Deck:* " + game.deck.length;
    
    
    if (game.step === "nominate") {
      text += "\n*Promotion Tracker*: " + game.promotionTracker;
      text += "\n*Manager Candidate*: " + name(game.manager);
      text += "\n*Instructions*: " + name(game.manager) + " nominate a code reviewer";
    } else if (game.step === "vote") {
      text += "\n*Promotion Tracker*: " + game.promotionTracker;
      text += "\n*Manager Candidate*: " + name(game.manager);
      text += "\n*Reviewer Candidate*: " + name(game.reviewer);
      text += "\n*Instructions*: Everyone vote Ja! or Nein! for this pair.";
      text += "\n*Votes*: " + Object.keys(game.votes).length + "/" + game.turnOrder.length;
    }

    const blocks = [
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": text
        }
      },
    ];
    
    // TODO: Move this out into a function startNominate which will PM the manager with the list of users to choose from
    if (game.step === "vote") {
      blocks.push({
        "type": "divider"
      });
      
      blocks.push({
        type: "actions",
        elements: [
          {
            type:"button" ,
            "action_id": "vote_ja",
            "text": {
              "type": "plain_text",
              "text": "Ja!",
              "emoji": true
            },
            "value": "ja",
            "style": "primary"
          },
          {
            type:"button" ,
            "action_id": "vote_nein",
            "text": {
              "type": "plain_text",
              "text": "Nein!",
              "emoji": true
            },
            "value": "nein",
            "style": "danger"
          },
          {
            type:"button" ,
            "action_id": "vote_withdraw",
            "text": {
              "type": "plain_text",
              "text": "Withdraw vote",
              "emoji": true
            },
            "value": "withdraw"
          }
        ]
      })
    }

    if (respond) {
      await respond({
        blocks: blocks,
        "replace_original": true
      });
    } else {
      await app.client.chat.postMessage({
        token: context.botToken,
        channel: channel,
        blocks: blocks
      });
    }
    
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

app.action(/^nominate_\d+$/, async({body, ack, respond, context}) => {
  ack();
  await respond({"delete_original": true});
  const value = body.actions[0].value;
  const [channel, player] = value.split("_");
  const game = GAMES[channel];
  
  game.reviewer = player;
  game.step = "vote";
  printStatus(body.channel.id, context);
});

app.action(/^vote_.*$/, async({body, ack, respond, context}) => {
  ack();
  const game = GAMES[body.channel.id];
  function name(player) {
    return game.players[player].name;
  }
  const vote = body.actions[0].value;
  if (vote === "withdraw") {
    delete game.votes[body.user.id];
  } else {
    game.votes[body.user.id] = vote;
  }
  
  // If everyone has voted
  if (Object.keys(game.votes).length === game.turnOrder.length) {
    let numNein = 0;
    let numJa = 0;
    const votes = {ja: [], nein: []};
    for (const player in game.votes) {
      votes[game.votes[player]].push(name(player));
    }
    
    // Print voting results
    await app.client.chat.postMessage({
      token: context.botToken,
      channel: body.channel.id,
      text: "*Voting Results*:\n*Ja*: " + votes.ja.join(", ") + "\n*Nein*: " + votes.nein.join(", ")
    });
    
    // Clear votes
    game.votes = {};
    
    // Check results
    if (votes.ja.length > votes.nein.length) { // Majority voted ja
      // Check if the game is over due to Dillon being promoted
      if (checkGameOver(game, context, game.step)) {
        return;
      }
      
      // Set the next ineligible reviewers
      if (game.turnOrder.length <= 5) {
        game.ineligibleReviewers = [game.reviewer];
      } else {
        game.ineligibleReviewers = [game.manager, game.reviewer];
      }
      
      // Move to the legislative step
      game.step = "legislative";
      sendManagerCards(game, context);
    } else {
      rotateManager(game);
      game.promotionTracker++;
      if (game.promotionTracker >= 3) {
        const randomResult = game.deck.pop();
        game[randomResult]++;
        game.promotionTracker = 0;
      }
      sendNominationForm(game, context);
    }
    await respond({"delete_original": true});
    printStatus(body.channel.id, context);
  } else {
    printStatus(body.channel.id, context, respond);
  }
});

app.action(/^selectCard_\d$/, async ({body, ack, respond, context}) => {
  ack();
  await respond({"delete_original": true});
  const value = body.actions[0].value;
  const [channel, index] = value.split("_");
  const game = GAMES[channel];
  
  // If there are currently 3 cards, it was the manager's pick
  if (game.hand.length === 3) {
    game.discard.push(game.hand.splice(parseInt(index), 1));
    sendCards(game, game.reviewer, "Choose a card to *play*. The other card will be discarded.", context);
  } else {
    // Increment the chosen counter
    const chosen = game.hand.splice(parseInt(index), 1);
    game[chosen]++;
    
    // Put the other card into discard
    game.discard.push(game.hand.pop());
    
    // Check if the game is over
    if (checkGameOver(game, context)) {
      return;
    }
    
    // Move to the executive step
    executiveStep(game, context);
  }
});

function rotateManager(game) {
  game.managerIndex = (game.managerIndex + 1) % game.turnOrder.length;
  game.manager = game.turnOrder[game.managerIndex];
  game.step = "nominate";
  game.reviewer = null;
}

function nextRound(game) {
  rotateManager(game);
  game.promotionTracker = 0;
}

async function executiveStep(chosen, game, context) {
  if (chosen === 'accept') {
    // With accept, there is no executive step, so move to the next round
    nextRound(game);
    sendNominationForm(game, context);
    printStatus(game.channel, context);
    return;
  }
  
  const numPlayers = Object.keys(game.players).length;
  
  if (game.reject === 1) {
    if (numPlayers >= 9) {
      // Identity
    }
  }
  
  if (game.reject === 2) {
    if (numPlayers >= 7) {
      // Identity
    }
  }
  
  if (game.reject === 3) {
    if (numPlayers >= 7) {
      // Special Promotion Period
    } else if (numPlayers >= 5) {
      // Examine
    }
  }
  
  if (game.reject === 4) {
    // Fire
  }
  
  if (game.reject === 5) {
    // Fire
  }
}

function checkGameOver(game, context, step) {
  let gameOver = false;
  if (game.accept >= 5) { // libbys win from 5 accepted PRs
    console.log(1);
    gameOver = true;
  } else if (game.reject >= 6) { // dillons win from 6 rejected PRs
    console.log(2);
    gameOver = true;
  } else if (step && (step === 'vote') && (game.reject >= 3) && (game.players[game.reviewer] === 'Dillon')) {
    console.log(3);
    // dillons win because Dillon promoted to reviewer after 3 rejected PRs
    gameOver = true;
  } else if (game.players[game.Dillon].state === "fired") { // libbys win because they fired Dillon
    console.log(4);
    gameOver = true;
  }
  
  console.log(gameOver);
  
  if (gameOver) {
    console.log('hi');
    delete GAMES[game.channel];
  }
  
  return gameOver;
}

async function sendManagerCards(game, context) {
  //const game = GAMES[channel];
  //console.log(game);
  
  // If the deck has fewer than 3 cards left, shuffle deck and discard together
  if (game.deck.length < 3) {
    game.deck = game.deck.concat(game.discard);
    shuffleArray(game.deck);
  }
  
  // Draw 3 cards into a hand
  game.hand = game.deck.splice(0, 3);
  
  // Send cards to manager
  sendCards(game, game.manager, "Choose a card to *discard*. The other two will be passed to " + game.players[game.reviewer].name + ".", context);
}

async function sendCards(game, player, instructions, context) {
  app.client.chat.postMessage({
    token: context.botToken,
    channel: player,
    blocks: [
      {
        type: "section",
        text: {
          "type": "mrkdwn",
          "text": instructions
        } 
      },
      {
        type: "actions",
        elements: game.hand.map((card, index) => {
          return {
            type:"button" ,
            "action_id": "selectCard_" + index,
            "text": {
              "type": "plain_text",
              "text": card === "reject" ? "Reject PR" : "Accept PR",
              "emoji": true
            },
            "value": `${game.channel}_${index}`,
            "style": card === "reject" ? "danger" : "primary"
          };
        })
      }
    ]
  });
}

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
    await newGame(message.channel, message.user, context);
    
    // TODO: Remove below test
    // const game = GAMES[message.channel];
    // game.step = "legislative";
    // game.manager = "U0766LV3J";
    // game.reviewer = "U0766LV3J";
    // sendManagerCards(game, context);
  }

});

// TODO: Add game to context with middleware?
// https://slack.dev/bolt/concepts#global-middleware
// https://slack.dev/bolt/concepts#context

(async () => {
  // Start your app
  await app.start(process.env.PORT || 3000);

  console.log('⚡️ Bolt app is running!');
  

})();
