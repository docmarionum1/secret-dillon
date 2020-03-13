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

type Card = "accept" | "reject";

type GameStep = "nominate" | "vote" | "review" | "managerial" | "over";