import {WebClient, WebAPICallResult} from '@slack/web-api';
import { Middleware, BlockAction, ButtonAction, SlackAction, SlackActionMiddlewareArgs } from "@slack/bolt";


interface UserInfoResult extends WebAPICallResult {
  user: {
      profile: {
          display_name: string;
          real_name: string;
      }
  }
}

interface Pin {
    message: {
        ts: string;
    }
}

interface PinsListResult extends WebAPICallResult {
    items: Pin[];
}

interface ChatPostMessageResult extends WebAPICallResult {
    ts: string;
}

type ActionHandler = Middleware<SlackActionMiddlewareArgs<BlockAction<ButtonAction>>>;

// declare module "@slack/bolt" {
//     export interface Context {
//       game?: string;
//     }
//   }

// declare module "@slack/bolt" {
//      interface Context {
//       game?: string;
//     }
//   }

type Card = "accept" | "reject";
type GameStep = "nominate" | "vote" | "review" | "managerial" | "over";
type Vote = "ja" | "nein";
type ManagerialPower = "peek" | "investigate" | "special" | "fire";
type Role = "waiting" | "libby" | "dillon" | "Dillon";
type NumPlayers = 5 | 6 | 7 | 8 | 9 | 10;
//type NumPlayers = 

interface Player {
  state: "employed" | "fired";
  name: string;
  realName: string;
  role: Role;
}


interface BaseGame {
  channel: string;
  gameId: string;
  players: {[playerId: string]: Player};
  pinnedMessage?: string;
  botToken: string;
  formId?: string;
}

interface LobbyGame extends BaseGame {
  step: "lobby";
}

interface StartedGame extends BaseGame {
  //step: GameStep;
  turnOrder: string[];
  numPlayers: NumPlayers;
  managerIndex: number;
  manager: string;
  reviewer?: string;
  ineligibleReviewers: string[];
  votes: {[player: string]: Vote};
  promotionTracker: 0 | 1 | 2 | 3;
  deck: Card[];
  discard: Card[];
  hand: Card[];
  accept: 0 | 1 | 2 | 3 | 4 | 5;
  reject: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  identified: string[];
  statusMessage?: string;
  managerialPowers: {[rejectCount: number]: ManagerialPower};
  Dillon: string;
  dillons: string[];
  libbys: string[];
}

interface NominateGame extends StartedGame {
  step: "nominate",
  //reviewer: never;
}

interface PostNominateGame extends StartedGame {
  step: "vote" | "review" | "managerial" | "over",
  reviewer: string;
}

type Game = LobbyGame | NominateGame | PostNominateGame;
type InProgressGame = NominateGame | PostNominateGame;
//
// interface NominateGame extends InProgressGame {
//   reviewer?: never;
// }
//
// interface
