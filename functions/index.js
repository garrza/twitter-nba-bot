const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const dbRef = admin.firestore().doc("twitter/credentials");

const TwitterAPI = require("twitter-api-v2").default;
const twitterClient = new TwitterAPI({
  clientId: "CLIENT_ID",
  clientSecret: "CLIENT_SECRET",
});

const callbackURL =
  "CALLBACK_FUNCTION";

// OpenAI API init
const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: "OPEN_AI_KEY",
});

// NBA API init
const axios = require("axios");
const nbaApiEndpoint = "https://api-nba-v1.p.rapidapi.com";

const nbaHeaders = {
  "X-RapidAPI-Key": "NBA_API_KEY",
  "X-RapidAPI-Host": "api-nba-v1.p.rapidapi.com",
};

let previousQuarters = {};

async function getLiveNBAGames() {
  const options = {
    method: "GET",
    url: `${nbaApiEndpoint}/games`,
    params: { live: "all" },
    headers: nbaHeaders,
  };

  try {
    const response = await axios.request(options);
    return response.data.api.games;
  } catch (error) {
    console.error("Error getting live NBA games:", error);
    throw error;
  }
}

async function tweetStats(tweetContent) {
  try {
    const { accessToken } = (await dbRef.get()).data();
    const refreshedClient = twitterClient.withAccessToken(accessToken);
    await refreshedClient.tweets.statusesUpdate({ status: tweetContent });
    console.log("Tweet posted successfully:", tweetContent);
  } catch (error) {
    console.error("Error posting tweet:", error);
    throw error;
  }
}

async function getStats(gameId) {
  try {
    const response = await axios.get(
      `${nbaApiEndpoint}/games/statistics?id=${gameId}`,
      {
        headers: nbaHeaders,
      }
    );

    const gameData = response.data.response[0]; // Assuming there's only one game in the response

    if (!gameData) {
      throw new Error("No game data found for the provided ID.");
    }

    // Initialize variables to track max stats
    let maxPointsTeam1 = 0;
    let maxAssistsTeam1 = 0;
    let maxTotRebTeam1 = 0;

    let maxPointsTeam2 = 0;
    let maxAssistsTeam2 = 0;
    let maxTotRebTeam2 = 0;

    // Loop through team statistics to find max values
    gameData.team.forEach((team) => {
      const teamStats = team.statistics[0];

      if (
        teamStats.points >
        (team.id === gameData.home_team ? maxPointsTeam1 : maxPointsTeam2)
      ) {
        team.id === gameData.home_team
          ? (maxPointsTeam1 = teamStats.points)
          : (maxPointsTeam2 = teamStats.points);
      }

      if (
        teamStats.assists >
        (team.id === gameData.home_team ? maxAssistsTeam1 : maxAssistsTeam2)
      ) {
        team.id === gameData.home_team
          ? (maxAssistsTeam1 = teamStats.assists)
          : (maxAssistsTeam2 = teamStats.assists);
      }

      if (
        teamStats.totReb >
        (team.id === gameData.home_team ? maxTotRebTeam1 : maxTotRebTeam2)
      ) {
        team.id === gameData.home_team
          ? (maxTotRebTeam1 = teamStats.totReb)
          : (maxTotRebTeam2 = teamStats.totReb);
      }
    });

    return {
      maxPointsTeam1,
      maxAssistsTeam1,
      maxTotRebTeam1,
      maxPointsTeam2,
      maxAssistsTeam2,
      maxTotRebTeam2,
    };
  } catch (error) {
    console.error("Error getting game stats:", error);
    throw error;
  }
}

async function tweetNBAScores() {
  try {
    const gamesResponse = await getLiveNBAGames();
    const games = gamesResponse.response || [];

    // Check if there are live games
    if (games.length === 0) {
      console.log("No live NBA games to tweet about.");
      return;
    }

    // Loop through games and tweet relevant information
    for (const game of games) {
      const {
        id,
        date,
        teams: { home, visitors },
        scores: { home: homeScores, visitors: visitorScores },
        periods,
        status,
      } = game;

      // Ensure there's a record for the game in previousQuarters
      previousQuarters[id] = previousQuarters[id] || 0;

      const tweetContent = `
          🏀 Live NBA Game:
          ${date.start} - ${home.name} vs ${visitors.name}
          Period: ${periods.current}/${periods.total}
          Status: ${status.long}
          ${home.name} ${homeScores.points} - ${visitors.name} ${visitorScores.points}
          #NBA #${home.code}vs${visitors.code}
        `;

      // Post the main tweet
      await tweetStats(tweetContent);

      // Tweet at the end of each quarter
      if (
        periods.current > 1 &&
        periods.current <= 4 &&
        periods.current !== previousQuarters[id] &&
        status.short !== "final"
      ) {
        const quarterEndTweet = `
            🏀 End of Q${periods.current}: ${home.name} ${homeScores.points} - ${visitors.name} ${visitorScores.points}
            #NBA #${home.code}vs${visitors.code}
          `;
        await tweetStats(quarterEndTweet);
        previousQuarters[id] = periods.current;
      }

      // Tweet leading stats for each quarter as replies
      for (let q = 1; q <= periods.current; q++) {
        const quarterStats = await getStats(id);

        const replyTweet = `
            Quarter ${q} Stats:
            ${home.name} Leading Scorer: ${quarterStats.maxPointsTeam1}
            ${visitors.name} Leading Scorer: ${quarterStats.maxPointsTeam2}
            ${home.name} Leading Rebounder: ${quarterStats.maxTotRebTeam1}
            ${visitors.name} Leading Rebounder: ${quarterStats.maxTotRebTeam2}
            ${home.name} Leading Assister: ${quarterStats.maxAssistsTeam1}
            ${visitors.name} Leading Assister: ${quarterStats.maxAssistsTeam2}
            #NBA #${home.code}vs${visitors.code}
          `;
        await tweetStats(replyTweet);
      }

      // Check if the game is over
      if (status.short === "final") {
        // Get team standings and generate a summary using OpenAI API
        const summary = await generateGameSummary(home, visitors);
        const winner =
          homeScores.points > visitorScores.points ? home.name : visitors.name;
        const finalTweet = `
            🏀 Final Score: ${home.name} ${homeScores.points} - ${visitors.name} ${visitorScores.points}
            Winner: ${winner}
            
            Summary:
            ${summary}
            #NBA
          `;
        await tweetStats(finalTweet);
      }
    }
  } catch (error) {
    console.error("Error tweeting NBA scores:", error);
    throw error;
  }
}

async function generateGameSummary(homeTeam, visitorTeam) {
  try {
    // Use the OpenAI API to generate a game summary based on team standings
    const summaryPrompt = `Generate a summary for the NBA game between ${homeTeam.name} and ${visitorTeam.name}.`;
    const response = await openai.createCompletion({
      engine: "text-davinci-002", // Adjust the engine based on your OpenAI subscription
      prompt: summaryPrompt,
      max_tokens: 150, // Adjust the max tokens as needed
    });

    // Extract the generated summary from the OpenAI API response
    const generatedSummary = response.data.choices[0].text.trim();

    return generatedSummary;
  } catch (error) {
    console.error("Error generating game summary:", error);
    throw error;
  }
}

// Generate a Twitter OAuth Request Token to start the process
exports.auth = functions.https.onRequest(async (req, res) => {
  const { url, codeVerifier, state } = twitterClient.generateOAuth2AuthLink(
    callbackURL,
    { scope: ["tweet.read", "tweet.write", "users.read", "offline.access"] }
  );

  // Save the code verifier to the database
  await dbRef.set({ codeVerifier, state });

  // Redirect the user to the Twitter OAuth URL
  res.redirect(url);
});

// After the user authenticates with Twitter, generate an Access Token
exports.callback = functions.https.onRequest(async (req, res) => {
  const { state, code } = req.query;

  const dbSnapshot = await dbRef.get();
  const { codeVerifier, state: storedState } = dbSnapshot.data();

  if (state !== storedState) {
    return res.status(400).send("Tokens do not match.");
  }

  const {
    client: loggedClient,
    accessToken,
    refreshToken,
  } = await twitterClient.loginWithOAuth2({
    code,
    codeVerifier,
    redirectUri: callbackURL,
  });

  // Save the access token to the database
  await dbRef.set({ accessToken, refreshToken });

  res.sendStatus(200);
});

// Post a Tweet on behalf of our bot
exports.tweet = functions.https.onRequest(async (req, res) => {
  const { refreshToken } = (await dbRef.get()).data();

  const {
    client: refreshedClient,
    accessToken,
    refreshToken: newRefreshToken,
  } = await twitterClient.refreshOAuth2Token(refreshToken);

  await dbRef.set({ accessToken, refreshToken: newRefreshToken });

  res.send("Tweet posted successfully");
});

exports.scheduleTweetNBAScores = functions.pubsub
  .schedule("every 5 minutes") // Adjust the schedule frequency as needed
  .timeZone("America/New_York") // Adjust the timezone as needed
  .onRun(async (context) => {
    try {
      // Invoke the function to tweet NBA scores
      await tweetNBAScores();
      console.log("Scheduled tweetNBAScores executed successfully.");
      return null;
    } catch (error) {
      console.error("Error in scheduled tweetNBAScores:", error);
      return null;
    }
  });
