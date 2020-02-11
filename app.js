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
    numPlayers: turnOrder.length,
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
    reject: 0,
    name: function(player) {return this.players[player].name;},
    identified: [],
    managerialPowers: {}
  };
  
  if (game.numPlayers >= 9) {
    game.managerialPowers = {
      1: "investigate",
      2: "investigate",
      3: "special",
      4: "fire",
      5: "fire"
    };
  } else if (game.numPlayers >= 7) {
    game.managerialPowers = {
      2: "investigate",
      3: "special",
      4: "fire",
      5: "fire"
    };
  } else if (game.numPlayers >= 5) {
    game.managerialPowers = {
      3: "peak",
      4: "fire",
      5: "fire"
    };
  }
  
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
    const role = game.players[player].role;
    let message = "";
    if (role === 'libby') {
      message =  "You are a libby";
    } else {
      if (role === 'dillon') {
        message = "You are a dillon (lowercase d)";
        message += `\nDillon is ${name(game.Dillon)}`;
      } else {
        message = "You are Dillon (captial D)";
      }
      
      if (role === 'dillon' || game.turnOrder.length <= 6) {
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
  console.log(game.ineligibleReviewers);
  const eligibleReviewers = game.turnOrder.filter(player => (game.ineligibleReviewers.indexOf(player) === -1) && (player !== game.manager));
  console.log(eligibleReviewers);
  
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
              text: game.name(player)
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
              "\n*Powers Remaining*:" + 
              "\n*Step*: " + game.step + 
              "\n*Cards in Deck:* " + game.deck.length;
    
    
    if (game.step === "nominate") {
      text += "\n*Promotion Tracker*: " + game.promotionTracker;
      text += "\n*Manager Candidate*: " + name(game.manager);
      text += "\n*Instructions*: Waiting for " + name(game.manager) + " to nominate a code reviewer";
    } else if (game.step === "vote") {
      text += "\n*Promotion Tracker*: " + game.promotionTracker;
      text += "\n*Manager Candidate*: " + name(game.manager);
      text += "\n*Reviewer Candidate*: " + name(game.reviewer);
      text += "\n*Instructions*: Everyone vote Ja! or Nein! for this pair.";
      text += "\n*Votes*: " + Object.keys(game.votes).length + "/" + game.turnOrder.length;
    } else if (game.step === "legislative") {
      text += `\n*Instructions*: Waiting for for ${game.name(game.manager)} and ${game.name(game.reviewer)} to review the PR`;
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
  printStatus(game.channel, context);
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
    const chosen = game.hand.splice(parseInt(index), 1)[0];
    game[chosen]++;
    
    // Put the other card into discard
    game.discard.push(game.hand.pop());
    
    // If the deck has fewer than 3 cards left, shuffle deck and discard together
    if (game.deck.length < 3) {
      game.deck = game.deck.concat(game.discard);
      shuffleArray(game.deck);
    }
    
    // Check if the game is over
    if (checkGameOver(game, context)) {
      return;
    }
    
    // Move to the executive step
    executiveStep(chosen, game, context);
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

function startNextRound(game, context) {
  nextRound(game);
  sendNominationForm(game, context);
  printStatus(game.channel, context);
}

async function executiveStep(chosen, game, context) {
  console.log(chosen);
  
  if (chosen === 'reject') {    
    const power = game.managerialPowers[game.reject];
    delete game.managerialPowers[game.reject];
    
    if (power === "investigate") {
      sendInvestigateForm(game, context);
      return;
    } else if (power === "special") {
      sendSpecialForm(game, context);
      return;
    } else if (power === "peak") {
      await peak(game, context);
      // Peak doesn't block next round
    } else if (power === "fire") {
      // Fire
      return; 
    }
  }
  
  startNextRound(game, context);
}

async function peak(game, context) {
  await app.client.chat.postMessage({
    token: context.botToken,
    channel: game.manager,
    blocks: [
      {
        type: "section",
        text: {
          "type": "mrkdwn",
          "text": `The top 3 cards of the deck are \n-${game.deck.slice(game.deck.length - 3).map(card => card === "reject" ? "❌ Reject PR" : "✔️ Accept PR").join("\n-")}` }  },
    ]
  });
  
  await app.client.chat.postMessage({
    token: context.botToken,
    channel: game.channel,
    blocks: [
      {
        type: "section",
        text: {
          "type": "mrkdwn",
          "text": `Showing ${game.name(game.manager)} the top three cards of the PR deck.`
        } 
      },
    ]
  });
}

async function sendInvestigateForm(game, context) {
  const eligiblePlayers = game.turnOrder.filter(player => (game.identified.indexOf(player) === -1) && (player !== game.manager));
  const groupText = `Waiting for ${game.name(game.manager)} to investigate a player.`;
  const privateText = `Pick a player to investigate:`;
  
  await sendForm(game, context, 'investigate', groupText, privateText, eligiblePlayers);
}

async function sendSpecialForm(game, context) {
  const eligiblePlayers = game.turnOrder.filter(player => player !== game.manager);
  const groupText = `Waiting for ${game.name(game.manager)} to nominate a player for a special promotion to manager.`;
  const privateText = `Pick a player to nominate for special promotion to manager:`;

  await sendForm(game, context, 'special', groupText, privateText, eligiblePlayers);
}

async function sendFireForm(game, context) {
  const eligiblePlayers = game.turnOrder.filter(player => player !== game.manager);
  const groupText = `Waiting for ${game.name(game.manager)} to fire a player.`;
  const privateText = `Pick a player to fire:`;

  await sendForm(game, context, 'fire', groupText, privateText, eligiblePlayers);
}

async function sendForm(game, context, type, groupText, privateText, eligiblePlayers) {
  // Post message to group channel
  await app.client.chat.postMessage({
    token: context.botToken,
    channel: game.channel,
    blocks: [
      {
        type: "section",
        text: {
          "type": "mrkdwn",
          "text": groupText
        } 
      },
    ]
  });
  
  // Send the manager a form to ask who to investigate
  await app.client.chat.postMessage({
    token: context.botToken,
    channel: game.manager,
    blocks: [
      {
        type: "section",
        text: {
          "type": "mrkdwn",
          "text": privateText
        } 
      },
      {
        "type": "divider"
      },
      {
        type: "actions",
        
        elements: eligiblePlayers.map((player, index) => {
          return {
            type: "button",
            "action_id": `${type}_${player}`,
            text: {
              type: "plain_text",
              text: game.name(player)
            },
            "value": `${game.channel}_${player}`
          };
        })
      }
    ]
  });
}

app.action(/^investigate_.*$/, async ({body, ack, respond, context}) => {
  ack();
  await respond({"delete_original": true});
  const value = body.actions[0].value;
  const [channel, target] = value.split("_");
  const game = GAMES[channel];
  
  const target_name = game.name(target);
  const manager_name = game.name(game.manager);
  
  // Send a message to the group to say who the manager investigated
  await app.client.chat.postMessage({
    token: context.botToken,
    channel: game.channel,
    blocks: [
      {
        type: "section",
        text: {
          "type": "mrkdwn",
          "text": `${manager_name} investigated ${target_name}.`
        } 
      },
    ]
  });
  
  // Send a message to the manager with the target's affilitaion
  await app.client.chat.postMessage({
    token: context.botToken,
    channel: game.manager,
    blocks: [
      {
        type: "section",
        text: {
          "type": "mrkdwn",
          "text": `${target_name} is a ${game.players[target].role.toLowerCase()}.`
        } 
      },
    ]
  });
  
  // Start the next round
  startNextRound(game, context);
});

app.action(/^special_.*$/, async ({body, ack, respond, context}) => {
  ack();
  await respond({"delete_original": true});
  const value = body.actions[0].value;
  const [channel, target] = value.split("_");
  const game = GAMES[channel];
  
  const target_name = game.name(target);
  const manager_name = game.name(game.manager);
  
  // Send a message to the group to say who the manager investigated
  await app.client.chat.postMessage({
    token: context.botToken,
    channel: game.channel,
    blocks: [
      {
        type: "section",
        text: {
          "type": "mrkdwn",
          "text": `${manager_name} nominated ${target_name} to go up for special promotion to manager.`
        } 
      },
    ]
  });
  
  // Start the next round with the special manager and without rotating the manager index
  game.manager = target;
  game.step = "nominate";
  game.reviewer = null;
  game.promotionTracker = 0;
  sendNominationForm(game, context);
  printStatus(game.channel, context);
});

app.action(/^fire_.*$/, async ({body, ack, respond, context}) => {
  ack();
  await respond({"delete_original": true});
  const value = body.actions[0].value;
  const [channel, target] = value.split("_");
  const game = GAMES[channel];
  
  const target_name = game.name(target);
  const manager_name = game.name(game.manager);
  
  // Send a message to the group to say who the manager fired
  await app.client.chat.postMessage({
    token: context.botToken,
    channel: game.channel,
    blocks: [
      {
        type: "section",
        text: {
          "type": "mrkdwn",
          "text": `☠️ ${manager_name} fired ${target_name} ☠️`
        } 
      },
    ]
  });
  
  game.players[target].state = "fired";
  game.turnOrder.splice(game.turnOrder.indexOf(target), 1);
  if (checkGameOver(game, context)) {
    return;
  }
  startNextRound(game, context);
});

function checkGameOver(game, context, step) {
  let gameOver = false;
  let message = "";
  if (game.accept >= 5) { // libbys win from 5 accepted PRs
    gameOver = true;
    message = ":orange: libbys win! :orange:";
  } else if (game.reject >= 6) { // dillons win from 6 rejected PRs
    gameOver = true;
    message = ":nollid: dillons win! :dillon:";
  } else if (step && (step === 'vote') && (game.reject >= 3) && (game.players[game.reviewer] === 'Dillon')) {
    // dillons win because Dillon promoted to reviewer after 3 rejected PRs
    gameOver = true;
    message = ":nollid: dillons win! :dillon:";
  } else if (game.players[game.Dillon].state === "fired") { // libbys win because they fired Dillon
    gameOver = true;
    message = `${game.name(game.Dillon)} was Dillon!\n:orange: libbys win! :orange:`;
  }
  
  if (gameOver) {
    delete GAMES[game.channel];
    app.client.chat.postMessage({
      token: context.botToken,
      channel: game.channel,
      text: message
    });
  }
  
  return gameOver;
}

async function sendManagerCards(game, context) {
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
    const game = GAMES[message.channel];
    // game.step = "legislative";
    game.manager = "U0766LV3J";
    game.reviewer = "U0766LV3J";
    // sendManagerCards(game, context);
    //sendInvestigateForm(game, context);
    // sendSpecialForm(game, context);
    // peak(game, context);
    // sendFireForm(game, context);
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
