import { App, RespondFn } from "@slack/bolt";
import {ChatPostMessageArguments, ActionsBlock, KnownBlock} from '@slack/web-api';
import { ActionHandler, UserInfoResult, PinsListResult, ChatPostMessageResult, Card, GameStep, Game, LobbyGame, InProgressGame, NumPlayers, ManagerialPower, Vote, NominateGame, PostNominateGame } from "./secret-dillon";
import { Datastore } from '@google-cloud/datastore';

// Creates a datastore client
const datastore = new Datastore();

// Create a lock for handling events that should be handled serially
const locks: {[channel: string]: boolean} = {};

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
} 

async function getLock(channel: string) {
  while (channel in locks && locks[channel] === false) {
    await sleep(10);
  }
  locks[channel] = true;
  return true;
}

function unLock(channel: string) {
  locks[channel] = false;
}

async function saveGame(game: Game) {
  const datastoreKey = datastore.key(["secret-dillon", game.channel]);
  try {
    if (game.step === "over") {
      await datastore.delete(datastoreKey);
    } else {
      await datastore.upsert({
        key: datastoreKey,
        data: JSON.parse(JSON.stringify(game))
      });
    }
  } catch (e) {
    console.log(e);
    console.log(game);
  }
  unLock(game.channel);
}

async function loadGame(channel: string) {
  const datastoreKey = datastore.key(["secret-dillon", channel]);
  const [game] = await datastore.get(datastoreKey);
  return game as Game;
}


const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});


//const GAMES: {[channelId: string]: Game} = {};

/**
 * Randomize array element order in-place.
 * Using Durstenfeld shuffle algorithm.
 */
function shuffleArray(array: any[]) {
    for (var i = array.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
}

const NUM_LIBBYS: {[numPlayers: number]: number} = {
  3: 1,
  4: 2,
  5: 3,
  6: 4,
  7: 4,
  8: 5,
  9: 5,
  10: 6
};

const POWERS: {[power in ManagerialPower]: string} = {
  investigate: "Investigate a player",
  special: "Special promotion",
  fire: "Fire a player",
  peek: "Peek at the top 3 PR cards"
};

declare module "@slack/bolt/dist/types/middleware" {
  interface Context {
    game: Game;
    value: string;
    botToken: string;
  }
}

const actionMiddleware: ActionHandler = async function ({
  body, ack, respond, context, next
}) {
  ack();
  const value = body.actions[0].value;
  let [channel, gameId, actionValue] = value.split("_");

  // Get a lock on the game to prevent events from happening in parallel
  await getLock(channel);

  // Sometimes the game ID is in the format gameId:formId
  // This is to prevent a form from being processed twice
  // If the formId does not match game.formId then return.
  let formId: string | undefined = undefined;
  if (gameId.includes(":")) {
    [gameId, formId] = gameId.split(":");
  }

  const game = await loadGame(channel);

  // Make sure the game exists and its for the right game
  // If the game is correct, make sure we haven't already processed this form
  if (!game || game.gameId !== gameId || (formId && "formId" in game && formId !== game.formId)) {
    respond({
      "delete_original": true,
      text: "rm"
    });
    unLock(channel);
    return;
  }

  game.formId = undefined;
  game.botToken = context.botToken;
  context.game = game;
  context.value = actionValue;

  next();
};

async function newGame(channel: string, botToken: string): Promise<LobbyGame> {
  const game: LobbyGame = {
    channel, botToken,
    gameId: Math.round(Math.random() * 99999999).toString(),
    players: {},
    step: "lobby"
  };
  clearPins(game);
  await createLobby(game);
  return game;
}

async function clearPins(game: Game) {
  // Remove old pinned messages
  const response = await app.client.pins.list({
    token: game.botToken,
    channel: game.channel,
  }) as PinsListResult;

  response.items.map(async (item) => await unpinMessage(game, item.message.ts));
}

async function pinMessage(game: Game, ts: string) {
  await app.client.pins.add({
    token: game.botToken,
    channel: game.channel,
    timestamp: ts
  });
}

async function unpinMessage(game: Game, ts: string) {
  await app.client.pins.remove({
    token: game.botToken,
    channel: game.channel,
    timestamp: ts
  });
}

async function unpinPinnedMessage(game: Game) {
  if (game.pinnedMessage) {
    await unpinMessage(game, game.pinnedMessage);
  }
  game.pinnedMessage = undefined;
}

function name(game: Game, player: string) {
  return game.players[player].name;
}

function addPlayer(game: LobbyGame, user: string, userInfo: UserInfoResult) {
  game.players[user] = {
    name: userInfo.user.profile.display_name,
    realName: userInfo.user.profile.real_name,
    state: "employed",
    role: "waiting",
  };
}

function removePlayer(game: LobbyGame, user: string) {
  delete game.players[user];
}



async function createLobby(game: LobbyGame) {
  const response = await postLobby(game);
  if (response) {
    game.pinnedMessage = response.ts;
    await pinMessage(game, game.pinnedMessage);
  }
}

async function postLobby (game: LobbyGame, respond?: RespondFn): Promise<ChatPostMessageResult | void> {
  const buttons: ActionsBlock = {
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

  if (Object.keys(game.players).length >= 5) {
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

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        "type": "mrkdwn",
        "text": `Starting a new game of Secret Dillon™.\n*Players*: ${Object.keys(game.players).map(player => name(game, player)).join(", ")}\nClick below to join!`
      }
    },
    {
      "type": "divider"
    },
    buttons
  ];

  if (respond) {
    return respond({
      blocks: blocks,
      "replace_original": true,
      text: ""
    });
  } else {
    return await app.client.chat.postMessage({
      token: game.botToken,
      channel: game.channel,
      blocks: blocks,
      text: ""
    }) as ChatPostMessageResult;
  }
}

function startGame(game: LobbyGame): NominateGame {
  const turnOrder = Object.keys(game.players);
  shuffleArray(turnOrder);

  const numPlayers = turnOrder.length as NumPlayers;

  // Set Managerial powers based on the number of players
  let managerialPowers: { [rejectCount: number]: ManagerialPower } = {};
  if (numPlayers >= 9) {
    managerialPowers = {
      1: "investigate",
      2: "investigate",
      3: "special",
      4: "fire",
      5: "fire"
    };
  } else if (numPlayers >= 7) {
    managerialPowers = {
      2: "investigate",
      3: "special",
      4: "fire",
      5: "fire"
    };
  } else if (numPlayers >= 5) {
    managerialPowers = {
      3: "peek",
      4: "fire",
      5: "fire"
    };
  }

  // Set up deck
  const deck: Card[] = [];
  for (let i = 0; i < 6; i++) {
    deck.push("accept");
  }
  for (let i = 0; i < 11; i++) {
    deck.push("reject");
  }
  shuffleArray(deck);

  // Set roles for each player
  const playerIds = Object.keys(game.players);
  shuffleArray(playerIds);
  const numDillons = playerIds.length - NUM_LIBBYS[playerIds.length] - 1;

  // Create the Dillon (captial D)
  let player = playerIds.pop() as string;
  const Dillon = player;
  game.players[player].role = "Dillon";

  // Create the dillons (lowercase d)
  const dillons = [];
  for (let i = 0; i < numDillons; i++) {
    let player = playerIds.pop() as string;
    dillons.push(player);
    game.players[player].role = "dillon";
  }

  // Make the rest libbys
  const libbys = [];
  while (player = playerIds.pop() as string) {
    libbys.push(player);
    game.players[player].role = "libby";
  }

  return {
    ...game,
    turnOrder, numPlayers, managerialPowers, deck,
    Dillon, dillons, libbys,

    // Start manager at first player
    managerIndex: 0,
    manager: turnOrder[0],

    // Start on the nominate step
    step: "nominate",

    // Initialize everything else
    ineligibleReviewers: [],
    votes: {},
    promotionTracker: 0,
    discard: [],
    hand: [],
    accept: 0,
    reject: 0,
    identified: [],
  };
}



async function sendStartMessages(game: InProgressGame) {
  // Send a message to each player with their identity
  for (const player in game.players) {
    const role = game.players[player].role;
    let message = "";
    if (role === 'libby') {
      message =  "You are a libby";
    } else {
      if (role === 'dillon') {
        message = "You are a dillon (lowercase d)";
        message += `\nDillon is ${name(game, game.Dillon)}`;
      } else {
        message = "You are Dillon (capital D)";
      }

      if (role === 'dillon' || game.numPlayers <= 6) {
        message += `\nThe other dillons are: ${game.dillons.filter(id => id !== player).map(id => name(game, id))}`;
      }
    }

    await app.client.chat.postMessage({
      token: game.botToken,
      channel: player,
      text: message
    });
  }

  await printMessage(game, ":sparkles::sparkles:Starting New Game:sparkles::sparkles:");
  await sendNominationForm(game);
}

async function status(game: InProgressGame) {
  let text = "*State*: ";
  if (game.step === "nominate") {
    text += `Waiting for ${name(game, game.manager)} to nominate a code reviewer`;
  } else if (game.step === "vote") {
    text += `Voting on ${name(game, game.manager)} (Manager) and ${name(game, game.reviewer!)} (Reviewer)`;
  } else if (game.step === "review") {
    text += `Waiting for ${name(game, game.manager)} (Manager) and ${name(game, game.reviewer!)} (Reviewer) to review the PR`;
  } else if (game.step === "managerial") {
    text += `Waiting for ${name(game, game.manager)} to use the managerial power.`;
  }

  text += `\n*Players*: ${game.turnOrder.map(player => name(game, player)).join(", ")}`;
  text += `\n*Score*: ${game.accept} Accepted; ${game.reject} Rejected`;
  text += "\n*Powers Remaining*: " + Object.entries(game.managerialPowers).map(([i, power]) => `(${i}) ${POWERS[power]}`).join(", ");
  text += `\n*Cards in Deck:* ${game.deck.length}`;
  text += `\n*Promotion Tracker*: ${game.promotionTracker}`;

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
  if (game.statusMessage) {
    return await app.client.chat.update({
      token: game.botToken,
      channel: game.channel,
      ts: game.statusMessage,
      blocks: blocks,
      text: "game status"
    });
  } else { // otherwise post a new one and pin it
    const response = await app.client.chat.postMessage({
      token: game.botToken,
      channel: game.channel,
      blocks: blocks,
      text: "game status"
    }) as ChatPostMessageResult;
    game.statusMessage = response.ts;
    await pinMessage(game, game.statusMessage);
    return response;
  }
}

async function printMessage(game: InProgressGame, message: string | KnownBlock[], channel?: string) {
  const payload: ChatPostMessageArguments = {
    token: game.botToken,
    channel: channel ? channel : game.channel,
    blocks: Array.isArray(message) ? message : undefined,
    text: Array.isArray(message) ? "" : message
  };

  await app.client.chat.postMessage(payload);
  await status(game);
}

async function nominate(game: InProgressGame, player: string) {
  game.reviewer = player;
  game.step = "vote";
  await printMessage(game, `${name(game, game.manager)} nominated ${name(game, game.reviewer)}.`);
  await showBallot(game as PostNominateGame);
}

async function showBallot(game: PostNominateGame) {
  const blocks: KnownBlock[] = [];

  let text = "";
  text += "\n*Manager Candidate*: " + name(game, game.manager);
  text += "\n*Reviewer Candidate*: " + name(game, game.reviewer!);
  text += "\n*Instructions*: Everyone vote Ja! or Nein! for this pair.";
  text += "\n*Votes*: " + Object.keys(game.votes).length + "/" + game.turnOrder.length;
  text += "\n*Players that haven't voted*:" + game.turnOrder.filter(player => !(player in game.votes)).map(player => name(game, player)).join(", ");

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
        "value": `${game.channel}_${game.gameId}_ja`,
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
        "value": `${game.channel}_${game.gameId}_nein`,
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
        "value": `${game.channel}_${game.gameId}_withdraw`
      }
    ]
  });

  if (game.pinnedMessage) {
    await app.client.chat.update({
      token: game.botToken,
      channel: game.channel,
      blocks: blocks,
      ts: game.pinnedMessage,
      text: "ballot"
    });
  } else {
    const response = await app.client.chat.postMessage({
      token: game.botToken,
      channel: game.channel,
      blocks: blocks,
      text: "ballot"
    }) as ChatPostMessageResult;
    game.pinnedMessage = response.ts;
    await pinMessage(game, game.pinnedMessage);
  }
}

function rotateManager(game: InProgressGame) {
  game.managerIndex = (game.managerIndex + 1) % game.turnOrder.length;
  game.manager = game.turnOrder[game.managerIndex];
  game.step = "nominate";
  game.reviewer = undefined;
}

function nextRound(game: InProgressGame) {
  rotateManager(game);
  game.promotionTracker = 0;
}

async function startNextRound(game: InProgressGame) {
  nextRound(game);
  await sendNominationForm(game);
  await status(game);
}

async function sendForm(
  game: InProgressGame,
  type: "nominate" | "investigate" | "special" | "fire",
  groupText: string, privateText: string, eligiblePlayers: string[]
) {
  await printMessage(game, groupText);

  game.formId = Math.round(Math.random() * 99999999).toString();

  // Send the manager a form
  await app.client.chat.postMessage({
    token: game.botToken,
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

        elements: eligiblePlayers.map((player) => {
          return {
            type: "button",
            "action_id": `${type}_${player}`,
            text: {
              type: "plain_text",
              text: name(game, player)
            },
            "value": `${game.channel}_${game.gameId}:${game.formId}_${player}`
          };
        })
      }
    ],
    text: "dm form"
  });
}

async function sendNominationForm(game: InProgressGame) {
  const eligiblePlayers = game.turnOrder.filter(player => (game.ineligibleReviewers.indexOf(player) === -1) && (player !== game.manager));
  const groupText = `Waiting for ${name(game, game.manager)} to nominate a player for reviewer.`;
  const privateText = "Pick a player to nominate for promotion to reviewer.";

  await sendForm(game, 'nominate', groupText, privateText, eligiblePlayers);
}

async function sendInvestigateForm(game: InProgressGame) {
  const eligiblePlayers = game.turnOrder.filter(player => (game.identified.indexOf(player) === -1) && (player !== game.manager));
  const groupText = `Waiting for ${name(game, game.manager)} to investigate a player.`;
  const privateText = `Pick a player to investigate:`;

  await sendForm(game, 'investigate', groupText, privateText, eligiblePlayers);
}

async function sendSpecialForm(game: InProgressGame) {
  const eligiblePlayers = game.turnOrder.filter(player => player !== game.manager);
  const groupText = `Waiting for ${name(game, game.manager)} to nominate a player for a special promotion to manager.`;
  const privateText = `Pick a player to nominate for special promotion to manager:`;

  await sendForm(game, 'special', groupText, privateText, eligiblePlayers);
}

async function sendFireForm(game: InProgressGame) {
  const eligiblePlayers = game.turnOrder.filter(player => player !== game.manager);
  const groupText = `Waiting for ${name(game, game.manager)} to fire a player.`;
  const privateText = `Pick a player to fire:`;

  await sendForm(game, 'fire', groupText, privateText, eligiblePlayers);
}

async function vote(game: PostNominateGame, user: string, vote: "ja" | "nein" | "withdraw", respond: RespondFn) {
  // Make sure user is in game and not fired
  if (!(user in game.players) || (game.players[user].state === "fired")) {
    return;
  }

  if (vote === "withdraw") {
    delete game.votes[user];
  } else {
    game.votes[user] = vote;
  }

  // If everyone has voted
  if (Object.keys(game.votes).length === game.turnOrder.length) {
    await unpinPinnedMessage(game);
    respond({"delete_original": true, text: "rm ballot"});
    await tallyVotes(game);
  } else {
    await showBallot(game);
  }
  await status(game);
}

async function tallyVotes(game: InProgressGame) {
  const votes: {ja: string[], nein: string[]} = {ja: [], nein: []};
  for (const player in game.votes) {
    votes[game.votes[player]].push(name(game, player));
  }

  // Print voting results
  await printMessage(game, `*Voting Results*:\n*Ja*: ${votes.ja.join(", ")}\n*Nein*: ${votes.nein.join(", ")}`);

  // Clear votes
  game.votes = {};

  // Check results
  if (votes.ja.length > votes.nein.length) { // Majority voted ja
    await voteSuccess(game);
  } else {
    await voteFailure(game);
  }
}

async function voteSuccess(game: InProgressGame) {
  // Check if the game is over due to Dillon being promoted
  if (await checkGameOver(game, game.step)) {
    return;
  }

  // If three or more rejects have been played, report that the current reviewer is not Dillon
  if (game.reject >= 3) {
    printMessage(game, `${name(game, game.reviewer!)} is not Dillon!`);
  }

  // Set the next ineligible reviewers
  if (game.turnOrder.length <= 5) {
    game.ineligibleReviewers = [game.reviewer!];
  } else {
    game.ineligibleReviewers = [game.manager, game.reviewer!];
  }

  // Move to the legislative step
  game.step = "review";
  await sendManagerCards(game);
}

async function voteFailure(game: InProgressGame) {
  const finishedTurn = await incrementPromotionTracker(game);
  if (!finishedTurn) {
    rotateManager(game);
    await sendNominationForm(game);
  }
}

async function incrementPromotionTracker(game: InProgressGame) {
  // Advance election tracker and check if === 3
  game.promotionTracker++;
  if (game.promotionTracker >= 3) {
    const randomResult = game.deck.pop() as Card;
    game[randomResult]++;

    await printMessage(game, `Due to three rejected promotions in a row, a *${randomResult}* was played from the top of the deck.`);

    // Shuffle if needed
    if (game.deck.length < 3) {
      game.deck = game.deck.concat(game.discard);
      shuffleArray(game.deck);
    }

    // Check if over because of the result
    if (!(await checkGameOver(game))) {
      await startNextRound(game);
    }

    // Reset ineligible reviewers after a failed promotion
    game.ineligibleReviewers = [];

    return true;
  }
  return false;
}

async function checkGameOver(game: InProgressGame, step?: GameStep): Promise<boolean> {
  let gameOver = false;
  let message = "";
  if (game.accept >= 5) { // libbys win from 5 accepted PRs
    gameOver = true;
    message = ":orange: libbys win! :orange:";
  } else if (game.reject >= 6) { // dillons win from 6 rejected PRs
    gameOver = true;
    message = ":nollid: dillons win! :dillon:";
  } else if (step && (step === 'vote') && (game.reject >= 3) && (game.players[game.reviewer!].role === 'Dillon')) {
    // dillons win because Dillon promoted to reviewer after 3 rejected PRs
    gameOver = true;
    message = `${name(game, game.Dillon)} was Dillon and became code reviewer!\n:nollid: dillons win! :dillon:`;
  } else if (game.players[game.Dillon].state === "fired") { // libbys win because they fired Dillon
    gameOver = true;
    message = `${name(game, game.Dillon)} was Dillon!\n:orange: libbys win! :orange:`;
  }

  if (gameOver) {
    //TODO When saving game, don't save if the step === "over"
    //delete GAMES[game.channel];
    game.step = "over";
    await printMessage(game, message);
  }

  return gameOver;
}

async function sendCards(game: InProgressGame, playerId: string, instructions: string, includeVeto=true) {
  const buttons: ActionsBlock['elements'] = game.hand.map((card, index) => {
    return {
      type:"button" ,
      "action_id": "selectCard_" + index,
      "text": {
        "type": "plain_text",
        "text": card === "reject" ? "Reject PR" : "Accept PR",
        "emoji": true
      },
      "value": `${game.channel}_${game.gameId}_${index}`,
      "style": card === "reject" ? "danger" : "primary"
    };
  });

  // Check if veto power is active, if so, include a "Veto" button for the reviewer
  if (includeVeto && (game.reject >= 5) && (buttons.length === 2)) {
    buttons.push({
      type:"button" ,
      "action_id": "veto",
      "text": {
        "type": "plain_text",
        "text": "Veto",
        "emoji": true
      },
      "value": `${game.channel}_${game.gameId}_veto`
    });
  }

  app.client.chat.postMessage({
    token: game.botToken,
    channel: playerId,
    text: instructions,
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

async function sendManagerCards(game: InProgressGame) {
  game.hand = game.deck.splice(game.deck.length - 3, 3);

  await sendCards(game, game.manager, `Choose a card to *discard*. The other two will be passed to ${name(game, game.reviewer!)}.`);
  await printMessage(game, `${name(game, game.manager)} drew 3 cards.`);
}

async function vetoResponse(game: InProgressGame, choice: "ja" | "nein") {
  if (choice === "ja") {
    // If yes, discard the cards
    game.discard.push(game.hand.pop()!);
    game.discard.push(game.hand.pop()!);

    // If this pushed the promotionTracker to 3, end this turn
    const finishedTurn = await incrementPromotionTracker(game);
    if (finishedTurn) {
      return;
    }

    // Shuffle if needed
    if (game.deck.length < 3) {
      game.deck = game.deck.concat(game.discard);
      shuffleArray(game.deck);
    }

    // Send new cards to manager
    await sendManagerCards(game);

    await printMessage(game, `*${name(game, game.reviewer!)} and ${name(game, game.manager)} vetoed the PR.*`);
  } else {
    await sendCards(game, game.reviewer!, `${name(game, game.manager)} has *rejected* the veto.\nChoose a card to *play*. The other card will be discarded.`, false);
    await printMessage(game, `${name(game, game.reviewer!)} suggested a veto but ${name(game, game.manager)} *rejected* it. Waiting for ${name(game, game.reviewer!)} to play a card.`);
  }
}

async function selectCard(game: InProgressGame, indexString: string) {
  const index = parseInt(indexString);
  // If there are currently 3 cards, it was the manager's pick
  if (game.hand.length === 3) {
    game.discard.push(...game.hand.splice(index, 1));
    await sendCards(game, game.reviewer!, "Choose a card to *play*. The other card will be discarded.");
    await printMessage(game, `${name(game, game.manager)} passed 2 cards to ${name(game, game.reviewer!)}.`);
  } else { // Otherwise, it was the reviewer picking the card to play
    // Increment the chosen counter
    const chosen = game.hand.splice(index, 1)[0];
    game[chosen]++;

    await printMessage(game, `${name(game, game.reviewer!)} played *${chosen}*.`);

    // Put the other card into discard
    game.discard.push(game.hand.pop()!);

    // If the deck has fewer than 3 cards left, shuffle deck and discard together
    if (game.deck.length < 3) {
      game.deck = game.deck.concat(game.discard);
      shuffleArray(game.deck);
    }

    // Check if the game is over
    if (await checkGameOver(game)) {
      return;
    }

    // Move to the executive step
    if (chosen === 'accept' || game.managerialPowers[game.reject] === undefined) {
      await startNextRound(game);
    } else {
      await managerialStep(game);
    }
  }
}

async function managerialStep(game: InProgressGame) {
  const power = game.managerialPowers[game.reject];
  delete game.managerialPowers[game.reject];
  game.step = "managerial";

  if (power === "investigate") {
    await sendInvestigateForm(game);
  } else if (power === "special") {
    await sendSpecialForm(game);
  } else if (power === "peek") {
    await peek(game);
  } else if (power === "fire") {
    await sendFireForm(game);
  }

  return true;
}

async function peek(game: InProgressGame) {
  await printMessage(game,
    `The top 3 cards of the deck (starting with the top card) are \n-${game.deck.slice(game.deck.length - 3).reverse().map(
        card => card === "reject" ? "❌ Reject PR" : "✔️ Accept PR").join("\n-")}`,
    game.manager
  );
  await printMessage(game, `Showing ${name(game, game.manager)} the top three cards of the PR deck.`);

  await startNextRound(game);
}

async function investigate(game: InProgressGame, player: string) {
  if (game.players[player]) {
    await printMessage(game,
      `${name(game, player)} is a ${game.players[player].role.toLowerCase()}.`,
      game.manager
    );
  }
  await printMessage(game, `${name(game, game.manager)} investigated ${name(game, player)}.`);

  await startNextRound(game);
}

async function specialPromotion(game: InProgressGame, player: string) {
  await printMessage(game,
    `${name(game, game.manager)} nominated ${name(game, player)} to go up for special promotion to manager.`
  );

  // Start the next round with the special manager and without rotating the manager index
  game.manager = player;
  game.step = "nominate";
  game.reviewer = undefined;
  game.promotionTracker = 0;

  await sendNominationForm(game);
}

async function fire(game: InProgressGame, player: string) {
  await printMessage(game, `☠️ ${name(game, game.manager)} fired ${name(game, player)}. ☠️`);

  game.players[player].state = "fired";
  const index = game.turnOrder.indexOf(player);
  game.turnOrder.splice(index, 1);

  // Set the managerIndex to the new index of the manager after removing the fired player.
  game.managerIndex = game.turnOrder.indexOf(game.manager);

  if (!(await checkGameOver(game))) {
    startNextRound(game);
  }
}





app.message(/^new$/, async ({ message, context }) => {
  // TODO: try to Load game
  const game = await loadGame(message.channel);
  if (game) {
    const text = "A game is already in progress - are you sure you want to end the current game and start a new one?";
    app.client.chat.postEphemeral({
      token: context.botToken,
      channel: message.channel,
      user: message.user,
      text: text,
      "blocks": [
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": text
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
  } else {
    const game = await newGame(message.channel, context.botToken);
    await saveGame(game);
  }
});

app.action("new_game", async ({ body, ack, respond, context }) => {
  ack();
  respond({ "delete_original": true, text: "" });
  const game = await newGame(body.channel!.id, context.botToken);
  await saveGame(game);
});

app.action(/start/, actionMiddleware, async ({ respond, context }) => {
  const lobby = context.game;
  if (lobby.step === "lobby") {
    await unpinPinnedMessage(lobby);
    respond({ "delete_original": true, text: "" });
    const game = startGame(lobby);
    await sendStartMessages(game);
    await saveGame(game);
  }
});

app.action(/^nominate_.*$/, actionMiddleware, async({respond, context}) => {
  respond({"delete_original": true, text: ""});
  if (context.game.step === "nominate") {
    await nominate(context.game, context.value);
    await saveGame(context.game);
  }
});

app.action(/^vote_.*$/, actionMiddleware, async({body, respond, context}) => {
  if (context.game.step === "vote") {
    await vote(context.game, body.user.id, context.value as Vote | "withdraw", respond);
    await checkGameOver(context.game);
    await saveGame(context.game);
  }
});

app.action("veto", actionMiddleware, async ({respond, context}) => {
  respond({"delete_original": true, text: ""});
  const game = context.game;
  if (game.step === "review") {
    const text = `${name(game, game.reviewer)} would like to veto this PR. Do you agree?`;

    // Send a message to the manager asking whether they'd like to veto
    await app.client.chat.postMessage({
      token: context.botToken,
      channel: game.manager,
      text: text,
      blocks: [
        {
          type: "section",
          text: {
            "type": "mrkdwn",
            "text": text
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
  }
});

app.action(/^veto_.*$/, actionMiddleware, async ({respond, context}) => {
  respond({"delete_original": true, text: ""});
  if (context.game.step === "review") {
    await vetoResponse(context.game, context.value as Vote);
    await checkGameOver(context.game);
    await saveGame(context.game);
  }
});

app.action(/^selectCard_\d$/, actionMiddleware, async ({respond, context}) => {
  respond({"delete_original": true, text: ""});
  if (context.game.step === "review") {
    await selectCard(context.game, context.value);
    await checkGameOver(context.game);
    await saveGame(context.game);
  }
});

app.action(/^investigate_.*$/, actionMiddleware, async ({respond, context}) => {
  respond({"delete_original": true, text: ""});
  if (context.game.step === "managerial") {
    await investigate(context.game, context.value);
    await saveGame(context.game);
  }
});

app.action(/^special_.*$/, actionMiddleware, async ({respond, context}) => {
  respond({"delete_original": true, text: ""});
  if (context.game.step === "managerial") {
    await specialPromotion(context.game, context.value);
    await saveGame(context.game);
  }
});

app.action(/^fire_.*$/, actionMiddleware, async ({respond, context}) => {
  respond({"delete_original": true, text: ""});
  if (context.game.step === "managerial") {
    await fire(context.game, context.value);
    await checkGameOver(context.game);
    await saveGame(context.game);
  }
});

const lobbyAction: ActionHandler = async ({body, respond, context}) => {
  const game = context.game;
  const user = body.user.id;
  const choice = context.value;

  if (game.step === "lobby") {

    if (choice === "join") {
      if (Object.keys(game.players).length < 10) {
        const userInfo = await app.client.users.info({
          token: context.botToken,
          user: user,
        }) as UserInfoResult;

        addPlayer(game, user, userInfo);
      }
    } else {
      removePlayer(game, user);
    }

    await postLobby(game, respond);
    await saveGame(game);
  }
};

app.action(/^lobby_.*$/, actionMiddleware, lobbyAction);



(async () => {
  // Start your app
  await app.start(process.env.PORT || 3000);

  console.log('⚡️ Bolt app is running!');
})();
