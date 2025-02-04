// Load environment variables from `.env` file (optional)
require('dotenv').config();

const slackEventsApi = require('@slack/events-api');
const SlackClient = require('@slack/client').WebClient;
const passport = require('passport');
const SlackStrategy = require('@aoberoi/passport-slack').default.Strategy;
const http = require('http');
const path = require('path');
const express = require('express');
const ndbx = require('node-dropbox');
const XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
const dropKey = process.env.DROPBOX_APP_KEY;
const dropSecret = process.env.DROPBOX_APP_SECRET;
const uuid = require('uuid/v4');
const siteAddress = process.env.SITE_ADDRESS
var dropToken = 'undefined';
 
// var api = ndbx.api(dropToken);

var trustProxy = false;

// *** Initialize event adapter using signing secret from environment variables ***
const slackEvents = slackEventsApi.createEventAdapter(process.env.SLACK_SIGNING_SECRET, {
  includeBody: true
});

// Initialize a data structures to store team authorization info (typically stored in a database)
const botAuthorizations = {}
var authToken;

// Helpers to cache and lookup appropriate client
// NOTE: Not enterprise-ready. if the event was triggered inside a shared channel, this lookup
// could fail but there might be a suitable client from one of the other teams that is within that
// shared channel.
const clients = {};
function getClientByTeamId(teamId) {
  if (!clients[teamId] && botAuthorizations[teamId]) {
    clients[teamId] = new SlackClient(botAuthorizations[teamId]);
  }
  if (clients[teamId]) {
    return clients[teamId];
  }
  return null;
}

// Initialize Add to Slack (OAuth) helpers
passport.use(new SlackStrategy({
  apiVersion: '2',
  clientID: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  skipUserProfile: true,
}, (accessToken, scopes, team, extra, profiles, done) => {
  authToken = accessToken;
  botAuthorizations[team.id] = extra.bot.accessToken;
  done(null, {});
}));



// Initialize an Express application
const app = express();

// Plug the Add to Slack (OAuth) helpers into the express app
app.use(passport.initialize());
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});
app.get('/auth/slack', passport.authenticate('slack', {
  scope: ['bot', 'im:read', 'im:write']
}));
app.get('/auth/slack/callback',
  passport.authenticate('slack', { session: false }),
  (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'auth.html'));
  },
  (err, req, res, next) => {
    res.status(500).send(`<p>Horme Conversation Saver failed to install</p> <pre>${err}</pre>`);
  }
);

app.get('/login/dropbox', (req, res)=>{
  ndbx.Authenticate(dropKey, dropSecret, siteAddress+'/oauth/callback', (err, url) => {
	//console.log(url);
    res.redirect(url)
  });
});

app.get('/oauth/callback', (req, res) => {
  // console.log(req)
  var rescode = req.query.code;
  ndbx.AccessToken(dropKey, dropSecret, rescode, siteAddress+'/oauth/callback', (err, body) => {
	var access_token = body.access_token;
  // console.log(body);
  dropToken = access_token;
  res.redirect('/dropbox')
}); 
});

app.get('/dropbox', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dropbox.html'))
})

app.get('/login',(req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'authdropbox.html'));
});


// *** Plug the event adapter into the express app as middleware ***
app.use('/slack/events', slackEvents.expressMiddleware());

// *** Attach listeners to the event adapter ***

// *** Greeting any user that says "hi" ***
slackEvents.on('message', (message, body) => {
    // Initialize a client
  const slack = getClientByTeamId(body.team_id);
  // Only deal with messages that have no subtype (plain messages) and contain 'hi'
  // console.log(message);
  if (message.type == "message") {
    if (message.subtype == "bot_message") {
      return
    }
    handleMessage(message, body);
  }
    // Handle initialization failure
    if (!slack) {
      return console.error('No authorization found for this team. Did you install this app again after restarting?');
    }
    
    
    // Respond to the message back in the same channel
    // slack.chat.postMessage({ channel: message.channel, text: `Hello <@${message.user}>! :tada:` })
    //  .catch(console.error);
  
});
const date = Date.now();

const saveHistory = (history, message, slack) => {
  var attachments = [
        {
            "fallback": "Authenticate your dropbox at https://saverbyhorme.glitch.me/login/dropbox",
            "actions": [
                {
                    "type": "button",
                    "text": "Authenticate Dropbox",
                    "url": "https://saverbyhorme.glitch.me/login/dropbox"
                }
            ]
        }
    ]
  if (dropToken == 'undefined') return slack.chat.postEphemeral({channel: message.channel, text: `Please sign in your Dropbox application to continue...`, attachments, user: message.user})
  const dfs = require('dropbox-fs')({
    apiKey: dropToken
  });
  dfs.writeFile(
    `/slackchathistory/slack-chat-${date}.json`,
    history,
    { encoding: "utf8" },
    (err, stat) => {
      if (err) {
        return  console.log(err);//slack.chat.postMessage({ channel: message.channel, text: "Sorry, <@"+message.user+">! "+err+" :sad" }).catch(console.error);
        
      }
      console.log(stat);
      slack.chat.postEphemeral({ channel: message.channel, text: "Hello <@"+message.user+">! Your chat history is saved to your dropbox public folder Type `check files` to check it :tada:" , user: message.user}).catch(console.error);
      
    }
  );
};

const getChannelHistory = (message, slack) => {
  var tokens = authToken;
  var url = `https://slack.com/api/conversations.history?token=${tokens}&channel=${message.channel}&pretty=1`;
  var xhr = new XMLHttpRequest();
  xhr.onreadystatechange = function() {
    if (xhr.readyState == 4 && xhr.status == 200)
      slack.chat.postEphemeral({ channel: message.channel, text: "<@"+ message.user +">! Now saving your chat history to dropbox..." , user : message.user})
    .catch(console.error);
      saveHistory(xhr.responseText, message, slack);
    // console.log(xhr.responseText)
  };
  xhr.open("GET", url, true);
  xhr.send();
};

const handleMessage = (data, body) => {
  var message = data.text;
  var channel = data.channel;
  const slack = getClientByTeamId(body.team_id);
  // if(typeof dropToken == 'undefined') return slack.chat.postMessage({channel: message.channel, text: `Please sign in your Dropbox application to continue...`})
  const dfs = require('dropbox-fs')({
    apiKey: dropToken
});
  // console.log(channel);
  if (
    message.includes(" signin") ||
    message.includes(" sign in")
  ) {
    
    var msg = `Authenticate your dropbox account by clicking`;
    var attachments = [
        {
            "fallback": "Authenticate your dropbox at https://saverbyhorme.glitch.me/login/dropbox",
            "actions": [
                {
                    "type": "button",
                    "text": "Authenticate Dropbox",
                    "url": "https://saverbyhorme.glitch.me/login/dropbox"
                }
            ]
        }
    ]
    slack.chat.postEphemeral({ channel, text: msg, attachments, user: data.user })
    .catch(console.error);
  }
  if (message.includes(" save history") || message.includes("save history")) {
    slack.chat.postEphemeral({ channel: channel, text: "<@"+ data.user +">! Getting your chat history from slack..." , user: data.user})
    .catch(console.error);
    getChannelHistory(data, slack);
  }
  if (message.includes(" help") || message.includes("@hormesaver help")) {
    slack.chat.postEphemeral({ channel: channel, text: `To save your chat history to dropbox,\n 
Kindly type \`save history\`. \n To do this required login in to your dropbox which you can also do by
Typing \`signin\` or \`sign in\` \n To check the files saved to dropbox type \`check files\` \n 
and sign out when you are through by typing \`sign out\` to prevent others using your Dropbox account because this app 
can only run for one user at a time. Because no database yet. Thank you :wink: :+1:`, user: data.user })
    .catch(console.error);
  }
  if(message.includes(" check files")){  dfs.readdir('/slackchathistory', (err, result) => {
    if (err) {
	return slack.chat.postEphemeral({ channel: channel, text: "Sorry! <@"+ data.user +">! Error while reading your dropbox folder..." , user: data.user})
    .catch(console.error);
    }
    // console.log(result);
      slack.chat.postEphemeral({ channel: channel, text: "<@"+ data.user +">! Your slack chat json hitsory files are : ", user: data.user })
    .catch(console.error);
    result.forEach(file => {
      
      slack.chat.postEphemeral({ channel: channel, text: file, user: data.user })
    .catch(console.error);
    });
});
  }
  
   if (message.includes(" sign out") || message.includes("sign out")) {
  	dropToken = 'undefined';
  	slack.chat.postEphemeral({ channel: channel, text: "<@"+ data.user +">! Your dropbox is unauthenticated!!", user: data.user })
	  .catch(console.error);
  }
};


// *** Responding to reactions with the same emoji ***
slackEvents.on('reaction_added', (event, body) => {
  // Initialize a client
  const slack = getClientByTeamId(body.team_id);
  // Handle initialization failure
  if (!slack) {
    return console.error('No authorization found for this team. Did you install this app again after restarting?');
  }
  // Respond to the reaction back with the same emoji
  slack.chat.postMessage(event.item.channel, `:${event.reaction}:`)
    .catch(console.error);
});

// *** Handle errors ***
slackEvents.on('error', (error) => {
  if (error.code === slackEventsApi.errorCodes.TOKEN_VERIFICATION_FAILURE) {
    // This error type also has a `body` propery containing the request body which failed verification.
    console.error(`An unverified request was sent to the Slack events Request URL. Request body: \
${JSON.stringify(error.body)}`);
    console.error(error);
  } else {
    console.error(`An error occurred while handling a Slack event: ${error.message}`);
  }
});

// Start the express application
const port = process.env.PORT || 3000;
http.createServer(app).listen(port, () => {
  console.log(`server listening on port ${port}`);
});
