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

async function actionMiddleware({body, ack, respond, context, next}) {
  ack();
  const value = body.actions[0].value;
  const [channel, gameId, actionValue] = value.split("_");
  const game = GAMES[channel];

  // Make sure the game exists and its for the right game
  if (!game || game.gameId !== gameId) {
    respond({"delete_original": true});
    return;
  }

  game.botToken = context.botToken;
  context.game = game;
  context.value = actionValue;

  next();
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
};

const POWERS = {
  investigate: "Investigate a player",
  special: "Special promotion",
  fire: "Fire a player",
  peak: "Peak at the top 3 PR cards"
};

class Player {
  constructor(userInfo) {
    this.state = "employed";
    this.name = userInfo.user.profile.display_name;
    this.realName = userInfo.user.profile.real_name
  }
}

class Game {
  constructor(channel, botToken) {
    this.channel = channel;
    this.gameId = Math.round(Math.random() * 99999999).toString();
    this.players = {};
    this.step = "lobby";
    this.pinnedMessage = undefined;
    this.botToken = botToken;
  }

  async createLobby(context) {
    const response = await postLobby(this, context);
    this.pinnedMessage = response.ts;
    await pinMessage(this.channel, this.pinnedMessage, context);
  }

  async start(context) {
    // Get a turn order
    this.turnOrder = Object.keys(this.players);
    shuffleArray(this.turnOrder);
    this.numPlayers = this.turnOrder.length;

    // Start manager at first player
    this.managerIndex = 0;
    this.manager = this.turnOrder[0];

    // Set Managerial powers based on the number of players
    if (this.numPlayers >= 9) {
      this.managerialPowers = {
        1: "investigate",
        2: "investigate",
        3: "special",
        4: "fire",
        5: "fire"
      };
    } else if (this.numPlayers >= 7) {
      this.managerialPowers = {
        2: "investigate",
        3: "special",
        4: "fire",
        5: "fire"
      };
    } else if (this.numPlayers >= 5) {
      this.managerialPowers = {
        3: "peak",
        4: "fire",
        5: "fire"
      };
    } else {
      this.managerialPowers = {};
    }

    // Set up deck
    this.deck = [];
    for (let i = 0; i < 6; i++) {
      this.deck.push("accept");
    }
    for (let i = 0; i < 11; i++) {
      this.deck.push("reject");
    }
    shuffleArray(this.deck);

    // Set roles for each player
    const players = Object.keys(this.players);
    shuffleArray(players);
    const numDillons = players.length - NUM_LIBBYS[players.length] - 1;

    // Create the Dillon (captial D)
    let player = players.pop();
    this.Dillon = player;
    this.players[player].role = "Dillon";

    // Create the dillons (lowercase d)
    this.dillons = [];
    for (let i = 0; i < numDillons; i++) {
      let player = players.pop();
      this.dillons.push(player);
      this.players[player].role = "dillon";
    }

    // Make the rest libbys
    this.libbys = [];
    while(player = players.pop()) {
      this.libbys.push(player);
      this.players[player].role = "libby";
    }

    // Send a message to each player with their identity
    for (player in this.players) {
      const role = this.players[player].role;
      let message = "";
      if (role === 'libby') {
        message =  "You are a libby";
      } else {
        if (role === 'dillon') {
          message = "You are a dillon (lowercase d)";
          message += `\nDillon is ${this.name(this.Dillon)}`;
        } else {
          message = "You are Dillon (capital D)";
        }

        if (role === 'dillon' || this.numPlayers <= 6) {
          message += `\nThe other dillons are: ${this.dillons.filter(id => id !== player).map(id => this.name(id))}`;
        }
      }

      app.client.chat.postMessage({
        token: context.botToken,
        channel: player,
        text: message
      });
    }

    // Set up the rest of the variables
    this.step = "nominate"; // nominate | vote | legislative | managerial,
    this.ineligibleReviewers = [];
    this.reviewer = null;
    this.votes = {};
    this.promotionTracker = 0;
    this.discard = [];
    this.hand = [];
    this.accept = 0;
    this.reject = 0;
    this.identified = [];
    this.statusMessage = undefined;

    //await this.status(context);
    await this.printMessage(":sparkles::sparkles:Starting New Game:sparkles::sparkles:", context);
    await this.sendNominationForm(context);
  }

  async status(context) {
    let text = "*State*: ";
    if (this.step === "nominate") {
      text += `Waiting for ${this.name(this.manager)} to nominate a code reviewer`;
    } else if (this.step === "vote") {
      text += `Voting on ${this.name(this.manager)} (Manager) and ${this.name(this.reviewer)} (Reviewer)`;
    } else if (this.step === "legislative") {
      text += `Waiting for ${this.name(this.manager)} (Manager) and ${this.name(this.reviewer)} (Reviewer) to review the PR`;
    } else if (this.step === "managerial") {
      text += `Waiting for ${this.name(this.manager)} to use the managerial power.`;
    }

    text += `\n*Players*: ${this.turnOrder.map(player => this.name(player)).join(", ")}`;
    text += `\n*Score*: ${this.accept} Accepted; ${this.reject} Rejected`;
    text += "\n*Powers Remaining*: " + Object.entries(this.managerialPowers).map(([i, power]) => `(${i}) ${POWERS[power]}`).join(", ");
    text += `\n*Cards in Deck:* ${this.deck.length}`;
    text += `\n*Promotion Tracker*: ${this.promotionTracker}`;

    const blocks = [
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": text
        }
      },
    ];

    // If a status message exists, update it
    if (this.statusMessage) {
      return await app.client.chat.update({
        token: context.botToken,
        channel: this.channel,
        ts: this.statusMessage,
        blocks: blocks
      });
    } else { // otherwise post a new one and pin it
      const response = await app.client.chat.postMessage({
        token: context.botToken,
        channel: this.channel,
        blocks: blocks
      });
      this.statusMessage = response.ts;
      await pinMessage(this.channel, this.statusMessage, context);
      return response;
    }
  }

  async printMessage(message, context, channel) {
    const payload = {
      token: context.botToken,
      channel: this.channel
    };

    if (Array.isArray(message)) {
      payload.blocks = message;
    } else {
      payload.text = message;
    }

    await app.client.chat.postMessage(payload);
    await this.status(context);
  }

  async nominate(player, context) {
    this.reviewer = player;
    this.step = "vote";
    await this.printMessage(`${this.name(this.manager)} nominated ${this.name(this.reviewer)}.`, context);
    await this.showBallot(context);
  }

  async showBallot(context) {
    const blocks = [];

    let text = "";
    text += "\n*Manager Candidate*: " + this.name(this.manager);
    text += "\n*Reviewer Candidate*: " + this.name(this.reviewer);
    text += "\n*Instructions*: Everyone vote Ja! or Nein! for this pair.";
    text += "\n*Votes*: " + Object.keys(this.votes).length + "/" + this.turnOrder.length;
    text += "\n*Players that haven't voted*:" + Object.keys(this.players).filter(player => !(player in this.votes)).map(player => this.name(player)).join(", ");

    blocks.push({
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": text
      }
    });

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
          "value": `${this.channel}_${this.gameId}_ja`,
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
          "value": `${this.channel}_${this.gameId}_nein`,
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
          "value": `${this.channel}_${this.gameId}_withdraw`
        }
      ]
    });

    if (this.pinnedMessage) {
      await app.client.chat.update({
        token: context.botToken,
        channel: this.channel,
        blocks: blocks,
        ts: this.pinnedMessage
      });
    } else {
      const response = await app.client.chat.postMessage({
        token: context.botToken,
        channel: this.channel,
        blocks: blocks
      });
      this.pinnedMessage = response.ts;
      await pinMessage(this.channel, this.pinnedMessage, context);
    }
  }

  addPlayer(user, userInfo) {
    this.players[user] = new Player(userInfo);
  }

  removePlayer(user) {
    delete this.players[user];
  }

  name(player) {
    return this.players[player].name;
  }

  rotateManager() {
    this.managerIndex = (this.managerIndex + 1) % this.turnOrder.length;
    this.manager = this.turnOrder[this.managerIndex];
    this.step = "nominate";
    this.reviewer = null;
  }

  nextRound() {
    this.rotateManager();
    this.promotionTracker = 0;
  }

  async startNextRound(context) {
    console.log(this);
    console.log("startNextRound");
    this.nextRound();
    await this.sendNominationForm(context);
    await this.status(context);
  }

  async sendForm(type, groupText, privateText, eligiblePlayers, context) {
    await this.printMessage(groupText, context);

    // Send the manager a form
    await app.client.chat.postMessage({
      token: context.botToken,
      channel: this.manager,
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
                text: this.name(player)
              },
              "value": `${this.channel}_${this.gameId}_${player}`
            };
          })
        }
      ]
    });
  }

  async sendNominationForm(context) {
    const eligiblePlayers = this.turnOrder.filter(player => (this.ineligibleReviewers.indexOf(player) === -1) && (player !== this.manager));
    const groupText = `Waiting for ${this.name(this.manager)} to nominate a player for reviewer.`;
    const privateText = "Pick a player to nominate for promotion to reviewer.";

    await this.sendForm('nominate', groupText, privateText, eligiblePlayers, context);
  }

  async sendInvestigateForm(context) {
    const eligiblePlayers = this.turnOrder.filter(player => (this.identified.indexOf(player) === -1) && (player !== this.manager));
    const groupText = `Waiting for ${this.name(this.manager)} to investigate a player.`;
    const privateText = `Pick a player to investigate:`;

    await this.sendForm('investigate', groupText, privateText, eligiblePlayers, context);
  }

  async sendSpecialForm(context) {
    const eligiblePlayers = this.turnOrder.filter(player => player !== this.manager);
    const groupText = `Waiting for ${this.name(this.manager)} to nominate a player for a special promotion to manager.`;
    const privateText = `Pick a player to nominate for special promotion to manager:`;

    await this.sendForm('special', groupText, privateText, eligiblePlayers, context);
  }

  async sendFireForm(context) {
    const eligiblePlayers = this.turnOrder.filter(player => player !== this.manager);
    const groupText = `Waiting for ${this.name(this.manager)} to fire a player.`;
    const privateText = `Pick a player to fire:`;

    await this.sendForm('fire', groupText, privateText, eligiblePlayers, context);
  }

  async vote(user, vote, context, respond) {
    // Make sure user is in game
    if (!(user in this.players)) {
      return;
    }

    if (vote === "withdraw") {
      delete this.votes[user];
    } else {
      this.votes[user] = vote;
    }

    // If everyone has voted
    if (Object.keys(this.votes).length === this.turnOrder.length) {
      await this.unpinPinnedMessage(this, context);
      await respond({"delete_original": true});
      await this.tallyVotes(context);
    } else {
      await this.showBallot(context);
    }
    await this.status(context);
  }

  async tallyVotes(context) {
    let numNein = 0;
    let numJa = 0;
    const votes = {ja: [], nein: []};
    for (const player in this.votes) {
      votes[this.votes[player]].push(this.name(player));
    }

    // Print voting results
    await this.printMessage(`*Voting Results*:\n*Ja*: ${votes.ja.join(", ")}\n*Nein*: ${votes.nein.join(", ")}`, context);

    // Clear votes
    this.votes = {};

    // Check results
    if (votes.ja.length > votes.nein.length) { // Majority voted ja
      await this.voteSuccess(context);
    } else {
      await this.voteFailure(context);
    }
  }

  async voteSuccess(context) {
    // Check if the game is over due to Dillon being promoted
    if (this.checkGameOver(context, this.step)) {
      return;
    }

    // Set the next ineligible reviewers
    if (this.turnOrder.length <= 5) {
      this.ineligibleReviewers = [this.reviewer];
    } else {
      this.ineligibleReviewers = [this.manager, this.reviewer];
    }

    // Move to the legislative step
    this.step = "legislative";
    await this.sendManagerCards(context);
  }

  async voteFailure(context) {
    const finishedTurn = await this.incrementPromotionTracker(context);
    if (!finishedTurn) {
      this.rotateManager();
      await this.sendNominationForm(context);
    }
  }

  async incrementPromotionTracker(context) {
    // Advance election tracker and check if === 3
    this.promotionTracker++;
    if (this.promotionTracker >= 3) {
      const randomResult = this.deck.pop();
      this[randomResult]++;

      // Check if over because of the result
      if (!this.checkGameOver(context)) {
        await this.startNextRound(context);
      }

      return true;
    }
    return false;
  }

  checkGameOver(context, step) {
    let gameOver = false;
    let message = "";
    if (this.accept >= 5) { // libbys win from 5 accepted PRs
      gameOver = true;
      message = ":orange: libbys win! :orange:";
    } else if (this.reject >= 6) { // dillons win from 6 rejected PRs
      gameOver = true;
      message = ":nollid: dillons win! :dillon:";
    } else if (step && (step === 'vote') && (this.reject >= 3) && (this.players[this.reviewer].role === 'Dillon')) {
      // dillons win because Dillon promoted to reviewer after 3 rejected PRs
      gameOver = true;
      message = `${this.name(this.Dillon)} was Dillon and became code reviewer!\n:nollid: dillons win! :dillon:`;
    } else if (this.players[this.Dillon].state === "fired") { // libbys win because they fired Dillon
      gameOver = true;
      message = `${this.name(this.Dillon)} was Dillon!\n:orange: libbys win! :orange:`;
    }

    if (gameOver) {
      //delete GAMES[game.channel];
      this.step = "over";
      this.printMessage(message, context);
    }

    return gameOver;
  }

  async sendCards(player, instructions, context, includeVeto=true) {
    const buttons = this.hand.map((card, index) => {
      return {
        type:"button" ,
        "action_id": "selectCard_" + index,
        "text": {
          "type": "plain_text",
          "text": card === "reject" ? "Reject PR" : "Accept PR",
          "emoji": true
        },
        "value": `${this.channel}_${this.gameId}_${index}`,
        "style": card === "reject" ? "danger" : "primary"
      };
    });

    // Check if veto power is active, if so, include a "Veto" button for the reviewer
    if (includeVeto && (this.reject >= 5) && (buttons.length === 2)) {
      buttons.push({
        type:"button" ,
        "action_id": "veto",
        "text": {
          "type": "plain_text",
          "text": "Veto",
          "emoji": true
        },
        "value": `${this.channel}_${this.gameId}_veto`
      });
    }

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
          elements: buttons
        }
      ]
    });
  }

  async sendManagerCards(context) {
    this.hand = this.deck.splice(this.deck.length - 3, 3);

    await this.sendCards(this.manager, `Choose a card to *discard*. The other two will be passed to ${this.name(this.reviewer)}.`, context);
    await this.printMessage(`${this.name(this.manager)} drew 3 cards.`, context);
  }

  async vetoResponse(choice, context) {
    if (choice === "ja") {
      // If yes, discard the cards
      this.discard.push(this.hand.pop());
      this.discard.push(this.hand.pop());

      // If this pushed the promotionTracker to 3, end this turn
      const finishedTurn = await this.incrementPromotionTracker(context);
      if (finishedTurn) {
        return;
      }

      // Shuffle if needed
      if (this.deck.length < 3) {
        this.deck = this.deck.concat(this.discard);
        shuffleArray(this.deck);
      }

      // Send new cards to manager
      await this.sendManagerCards(context);

      await this.printMessage(`*${this.name(this.reviewer)} and ${this.name(this.manager)} vetoed the PR.*`, context);
    } else {
      await this.sendCards(this.reviewer, `${this.name(this.manager)} has *rejected* the veto.\nChoose a card to *play*. The other card will be discarded.`, context, false);
      await this.printMessage(`${this.name(this.reviewer)} suggested a veto but ${this.name(this.manager)} *rejected* it. Waiting for ${this.name(this.reviewer)} to play a card.`);
    }
  }

  async selectCard(index, context) {
    // If there are currently 3 cards, it was the manager's pick
    if (this.hand.length === 3) {
      this.discard.push(this.hand.splice(parseInt(index), 1));
      await this.sendCards(this.reviewer, "Choose a card to *play*. The other card will be discarded.", context);
      await this.printMessage(`${this.name(this.manager)} passed 2 cards to ${this.name(this.reviewer)}.`, context);
    } else { // Otherwise, it was the reviewer picking the card to play
      // Increment the chosen counter
      const chosen = this.hand.splice(parseInt(index), 1)[0];
      this[chosen]++;

      await this.printMessage(`${this.name(this.reviewer)} played ${chosen}.`, context);

      // Put the other card into discard
      this.discard.push(this.hand.pop());

      // If the deck has fewer than 3 cards left, shuffle deck and discard together
      if (this.deck.length < 3) {
        this.deck = this.deck.concat(this.discard);
        shuffleArray(this.deck);
      }

      // Check if the game is over
      if (this.checkGameOver(context)) {
        return;
      }

      // Move to the executive step
      if (chosen === 'accept' || this.managerialPowers[this.reject] === undefined) {
        await this.startNextRound(context);
      } else {
        await this.managerialStep(context);
      }
    }
  }

  async managerialStep(context) {
    const power = this.managerialPowers[this.reject];
    delete this.managerialPowers[this.reject];
    this.step = "managerial";

    if (power === "investigate") {
      await this.sendInvestigateForm(context);
    } else if (power === "special") {
      await this.sendSpecialForm(context);
    } else if (power === "peak") {
      await this.peak(context);
    } else if (power === "fire") {
      await this.sendFireForm(context);
    }

    return true;
  }

  async peak(context) {
    await this.printMessage(
      `The top 3 cards of the deck are \n-${this.deck.slice(this.deck.length - 3).map(card => card === "reject" ? "❌ Reject PR" : "✔️ Accept PR").join("\n-")}`,
      context, this.manager
    );
    await this.printMessage(`Showing ${this.name(this.manager)} the top three cards of the PR deck.`, context);

    await this.startNextRound(context);
  }

  async investigate(player, context) {
    await this.printMessage(
      `${this.name(player)} is a ${this.players[player].role.toLowerCase()}.`,
      context, this.manager
    );
    await this.printMessage(`${this.name(this.manager)} investigated ${this.name(player)}.`, context);

    await this.startNextRound(context);
  }

  async specialPromotion(player, context) {
    // Start the next round with the special manager and without rotating the manager index
    this.manager = player;
    this.step = "nominate";
    this.reviewer = null;
    this.promotionTracker = 0;
    await this.printMessage(
      `${this.name(this.manager)} nominated ${this.name(player)} to go up for special promotion to manager.`,
      context
    );
    await this.sendNominationForm(context);
  }

  async fire(player, context) {
    await this.printMessage(`☠️ ${this.name(this.manager)} fired ${this.name(player)}. ☠️`, context);

    this.players[player].state = "fired";
    this.turnOrder.splice(this.turnOrder.indexOf(player), 1);
    if (!this.checkGameOver(context)) {
      this.startNextRound(context);
    }
  }

  async unpinPinnedMessage(context) {
    await unpinMessage(this.channel, this.pinnedMessage, context);
    this.pinnedMessage = undefined;
  }
}

app.action("new_game", async ({body, ack, respond, context}) => {
  ack();
  respond({"delete_original": true});
  await createLobby(body.channel.id, context);
});

app.action(/^nominate_.*$/, actionMiddleware, async({body, ack, respond, context}) => {
  await respond({"delete_original": true});
  context.game.nominate(context.value, context);
});

app.action(/^vote_.*$/, actionMiddleware, async({body, ack, respond, context}) => {
  await context.game.vote(body.user.id, context.value, context, respond);
  checkGameOver(context.game);
});

app.action("veto", actionMiddleware, async ({body, ack, respond, context}) => {
  await respond({"delete_original": true});
  const game = context.game;

  // Send a message to the manager asking whether they'd like to veto
  await app.client.chat.postMessage({
    token: context.botToken,
    channel: game.manager,
    blocks: [
      {
        type: "section",
        text: {
          "type": "mrkdwn",
          "text": `${game.name(game.reviewer)} would like to veto this PR. Do you agree?`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type:"button" ,
            "action_id": "veto_ja",
            "text": {
              "type": "plain_text",
              "text": "Ja!",
              "emoji": true
            },
            "value": `${game.channel}_${game.gameId}_ja`,
            "style": "primary"
          },
          {
            type:"button" ,
            "action_id": "veto_nein",
            "text": {
              "type": "plain_text",
              "text": "Nein!",
              "emoji": true
            },
            "value": `${game.channel}_${game.gameId}_nein`,
            "style": "danger"
          }
        ]
      }
    ]
  });
});

app.action(/^veto_.*$/, actionMiddleware, async ({body, ack, respond, context}) => {
  await respond({"delete_original": true});
  await context.game.vetoResponse(context.value, context);
  checkGameOver(context.game);
});

app.action(/^selectCard_\d$/, actionMiddleware, async ({body, ack, respond, context}) => {
  await respond({"delete_original": true});
  await context.game.selectCard(context.value, context);
  checkGameOver(context.game);
});

app.action(/^investigate_.*$/, actionMiddleware, async ({body, ack, respond, context}) => {
  await respond({"delete_original": true});
  await context.game.investigate(context.value, context);
});

app.action(/^special_.*$/, actionMiddleware, async ({body, ack, respond, context}) => {
  await respond({"delete_original": true});
  await context.game.specialPromotion(context.value, context);
});

app.action(/^fire_.*$/, actionMiddleware, async ({body, ack, respond, context}) => {
  await respond({"delete_original": true});
  await context.game.fire(context.value, context);
  checkGameOver(context.game);
});

function checkGameOver(game) {
  if (game.step === "over") {
    delete GAMES[game.channel];
  }
}

async function postLobby(game, context, respond) {
  const buttons = {
    type: "actions",
    elements: [
      {
        type:"button" ,
        "action_id": "lobby_join",
        "text": {
          "type": "plain_text",
          "text": "Join Game",
          "emoji": true
        },
        "value": `${game.channel}_${game.gameId}_join`,
      },
      {
        type:"button" ,
        "action_id": "lobby_leave",
        "text": {
          "type": "plain_text",
          "text": "Leave Game",
          "emoji": true
        },
        "value": `${game.channel}_${game.gameId}_leave`,
      }
    ]
  };

  if (Object.keys(game.players).length >= 3) {
    buttons.elements.push({
      type:"button" ,
      "action_id": "start",
      "text": {
        "type": "plain_text",
        "text": "Start Game!",
        "emoji": true
      },
      "value": `${game.channel}_${game.gameId}_start`,
      "style": "primary"
    });
  }

  const blocks = [
    {
      type: "section",
      text: {
        "type": "mrkdwn",
        "text": `Starting a new game of Secret Dillon™.\n*Players*: ${Object.keys(game.players).map(player => game.name(player)).join(", ")}\nClick below to join!`
      }
    },
    {
      "type": "divider"
    },
    buttons
  ];

  if (respond) {
    await respond({
      blocks: blocks,
      "replace_original": true
    });
  } else {
    return await app.client.chat.postMessage({
      token: context.botToken,
      channel: game.channel,
      blocks: blocks
    });
  }
}

app.action(/^lobby_.*$/, actionMiddleware, async ({body, ack, respond, context}) => {
  const game = context.game;
  const user = body.user.id;
  const choice = context.value;

  if (choice === "join") {
    if (Object.keys(game.players).length < 10) {
      const userInfo = await app.client.users.info({
        token: context.botToken,
        user: user,
      });

      game.addPlayer(user, userInfo);
    }
  } else {
    game.removePlayer(user);
  }

  postLobby(game, context, respond);
});

app.action(/start/, actionMiddleware, async ({body, ack, respond, context}) => {
  const game = context.game;
  await game.unpinPinnedMessage(context);
  await respond({"delete_original": true});
  game.start(context);
});

async function clearPins(channel, context) {
  // Remove old pinned messages
  const response = await app.client.pins.list({
    token: context.botToken,
    channel: channel,
  });

  await response.items.map(async function(item) {await unpinMessage(
    channel, item.message.ts, context
  )});
}

async function createLobby(channel, context) {
  clearPins(channel, context);

  const game = new Game(channel, context.botToken);
  GAMES[channel] = game;
  game.createLobby(context);
}

async function pinMessage(channel, ts, context) {
  await app.client.pins.add({
    token: context.botToken,
    channel: channel,
    timestamp: ts
  });
}

async function unpinMessage(channel, ts, context) {
  await app.client.pins.remove({
    token: context.botToken,
    channel: channel,
    timestamp: ts
  });
}



app.message(/^new$/, async ({message, context, say}) => {
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
    //await newGame(message.channel, message.user, context);

    // TODO: Remove below test
    //const game = GAMES[message.channel];
    // game.step = "legislative";
    //game.manager = "U0766LV3J";
    //game.reviewer = "U0766LV3J";
    // sendManagerCards(game, context);
    //sendInvestigateForm(game, context);
    // sendSpecialForm(game, context);
    // peak(game, context);
    // sendFireForm(game, context);
    await createLobby(message.channel, context);
  }
});

(async () => {
  // Start your app
  await app.start(process.env.PORT || 3000);

  console.log('⚡️ Bolt app is running!');
})();
