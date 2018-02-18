import { readFileSync } from 'fs';
import { request as _request } from 'https';

import Telegram from 'node-telegram-bot-api';
import express from 'express';
import { json } from 'body-parser';
import { generate } from 'randomstring';
import marked from 'marked';

const app = express();

const DEFAULT_PORT = 4321;
const MESSAGE_CACHE_TIME = 3600;
const TELEGRAM_TOKEN_LENGTH = 45;

const SUCCESS_RESPONSE_CODE = 204;
const ERROR_RESPONSE_CODE = 400;

const DATABASE_SUCCESS_STATUS_CODE = 201;

const [TELEGRAM_TOKEN, DATABASE_USER, DATABASE_PASSWORD] = [
  process.env.TELEGRAM_TOKEN,
  process.env.DATABASE_USER,
  process.env.DATABASE_PASSWORD
];
let telegramClient = false;

const sentMessages = {};
const users = {};

// eslint-disable-next-line no-sync
const readmeAsHTML = marked(readFileSync('./README.md', 'utf8'));

const pageMarkup = `<!DOCTYP html>
<html>
<head>
    <meta charset="utf-8"/>
    <title>
        Notifyy McNotifyFace
    </title>
    <link rel="stylesheet" href="https://cdn.rawgit.com/sindresorhus/github-markdown-css/gh-pages/github-markdown.css">
    <style>
        .markdown-body {
            box-sizing: border-box;
            min-width: 200px;
            max-width: 980px;
            margin: 0 auto;
            padding: 45px;
        }
    </style>
</head>
<body>
    <div class="markdown-body">
        ${readmeAsHTML}
    </div>
</body>
</html>`;

app.use(json());

const storeUser = function storeUser(token, user) {
  const userData = {};

  userData.token = token;
  for (const key in user) {
    if (!Reflect.apply({}.hasOwnProperty, user, key)) {
      return false;
    }

    userData[key] = user[key];
  }

  const postData = JSON.stringify(userData);

  const request = _request(
    {
      auth: `${DATABASE_USER}:${DATABASE_PASSWORD}`,
      headers: {
        'Content-Length': Buffer.byteLength(postData),
        'Content-Type': 'application/json'
      },
      hostname: 'kokarn.cloudant.com',
      method: 'POST',
      path: '/notifyy-users/',
      port: 443
    },
    response => {
      if (response.statusCode === DATABASE_SUCCESS_STATUS_CODE) {
        console.log('User', user.username, 'added to storage.');
      } else {
        console.err('Failed to add user', user.username, ' to storage. Got status', response.statusCode);
      }
    }
  ).on('error', error => {
    console.log(error.message);
  });

  request.write(postData);
  request.end();

  return true;
};

const loadUsers = function loadUsers() {
  const request = _request(
    {
      auth: `${DATABASE_USER}:${DATABASE_PASSWORD}`,
      hostname: 'kokarn.cloudant.com',
      method: 'GET',
      path: '/notifyy-users/_design/list/_view/all',
      port: 443
    },
    response => {
      let userData = '';

      response.setEncoding('utf8');

      response.on('data', chunk => {
        userData += chunk;
      });

      response.on('end', () => {
        const dataSet = JSON.parse(userData);

        for (let i = 0; i < dataSet.total_rows; i += 1) {
          users[dataSet.rows[i].value.token] = {
            chatId: dataSet.rows[i].value.chatId,
            username: dataSet.rows[i].value.username
          };
        }
        console.log('User database load complete');
      });
    }
  ).on('error', error => {
    console.log(error.message);
  });

  request.end();
};

const formatString = function formatString(string) {
  // string = string.replace(/</gim, '&lt;' );
  // string = string.replace(/>/gim, '&gt;' );
  // string = string.replace(/&/gim, '&amp;' );

  return string;
};

const buildMessage = function buildMessage(request) {
  let title = false;
  let message = false;
  let sendMessage = '';

  if (request.query.title && request.query.title.length > 0) {
    title = `* ${formatString(request.query.title)} *`;
  }

  if (request.query.message && request.query.message.length > 0) {
    message = formatString(request.query.message);
  }

  if (title) {
    if (sendMessage.length > 0) {
      sendMessage = `${sendMessage}\n`;
    }

    sendMessage += title;
  }

  if (message) {
    if (sendMessage.length > 0) {
      sendMessage = `${sendMessage}\n`;
    }

    sendMessage += message;
  }

  return sendMessage;
};

const sendMessage = function sendMessage(chatId, message) {
  const timestamp = process.hrtime();

  if (!sentMessages[chatId]) {
    sentMessages[chatId] = [];
  }

  for (let i = sentMessages[chatId].length - 1; i >= 0; i -= 1) {
    const messageSentDiff = process.hrtime(sentMessages[chatId][i].timestamp);

    // Check if it's an old message
    if (messageSentDiff[0] > MESSAGE_CACHE_TIME) {
      // If it's an old message, remove it and continue
      sentMessages[chatId].splice(i, 1);
      continue;
    }

    // Check if we've already sent a message in the last second
    if (messageSentDiff[0] === 0) {
      return false;
    }

    // Check if we've already sent this message
    if (sentMessages[chatId][i].message === message) {
      return false;
    }
  }

  telegramClient.sendMessage(chatId, message, {
    // eslint-disable-next-line camelcase
    parse_mode: 'markdown'
  });

  sentMessages[chatId].push({
    message,
    timestamp
  });

  return true;
};

app.get('/', (request, response) => {
  response.send(pageMarkup);
});

app.all('/out', (request, response, next) => {
  // If we got a message in body but not in query, use that
  if (request.body.message && !request.query.message) {
    request.query.message = request.body.message;
  }

  // If we got a title in body but not in query, use that
  if (request.body.title && !request.query.title) {
    request.query.title = request.body.title;
  }

  // If we got a url in body but not in query, use that
  if (request.body.url && !request.query.url) {
    request.query.url = request.body.url;
  }

  // If we got users in body but not in query, use that
  if (request.body.users && !request.query.users) {
    request.query.users = request.body.users;
  }

  // If we got a user in body but not in query, use that
  if (request.body.user && !request.query.user) {
    request.query.user = request.body.user;
  }

  // Fallback for when we provide the old "user" instead of "users"
  if (typeof request.query.user !== 'undefined' && typeof request.query.users === 'undefined') {
    if (typeof request.query.user === 'string') {
      request.query.users = [request.query.user];
    } else {
      request.query.users = request.query.user;
    }
  }

  if (!request.query.message && !request.query.title) {
    response.status(ERROR_RESPONSE_CODE).send();

    return false;
  }

  if (!request.query.users) {
    response.status(ERROR_RESPONSE_CODE).send();

    return false;
  }

  if (typeof request.query.users === 'string') {
    request.query.users = [request.query.users];
  }

  next();

  return true;
});

app.get('/out', (request, response) => {
  let messageString = buildMessage(request);
  let messageSent = false;

  if (request.query.url && request.query.url.length > 0) {
    messageString = `${messageString}\n${request.query.url}`;
  }

  for (let i = 0; i < request.query.users.length; i += 1) {
    if (!users[request.query.users[i]]) {
      continue;
    }

    messageSent = true;

    sendMessage(users[request.query.users[i]].chatId, messageString);
  }

  if (!messageSent) {
    response.status(ERROR_RESPONSE_CODE).send();

    return false;
  }

  response.status(SUCCESS_RESPONSE_CODE).send();

  return true;
});

app.post('/out', (request, response) => {
  let messageString = buildMessage(request);
  let messageSent = false;

  if (request.body.code && request.body.code.length > 0) {
    let formattedCode = request.body.code.replace(/\\n/gim, '\n');

    formattedCode = formattedCode.replace(/"/gim, '"');
    messageString = `${messageString}\n\`\`\`\n${formattedCode}\n\`\`\``;
  }

  if (request.query.url && request.query.url.length > 0) {
    messageString = `${messageString}\n${request.query.url}`;
  }

  for (let i = 0; i < request.query.users.length; i += 1) {
    if (!users[request.query.users[i]]) {
      continue;
    }

    messageSent = true;
    sendMessage(users[request.query.users[i]].chatId, messageString);
  }

  if (!messageSent) {
    response.status(ERROR_RESPONSE_CODE).send();

    return false;
  }

  response.status(SUCCESS_RESPONSE_CODE).send();

  return true;
});

if (!TELEGRAM_TOKEN) {
  throw new Error('Missing telegram token. Please add the environment variable TELEGRAM_TOKEN with a valid token.');
}

if (TELEGRAM_TOKEN.length < TELEGRAM_TOKEN_LENGTH) {
  throw new Error('Invalid telegram token passed in with TELEGRAM_TOKEN.');
}

if (!DATABASE_USER) {
  throw new Error('Missing database user. Please add the environment variable DATABASE_USER with a valid string.');
}

if (!DATABASE_PASSWORD) {
  throw new Error('Missing database password. Please add the environment variable DATABASE_PASSWORD with a valid string.');
}

telegramClient = new Telegram(TELEGRAM_TOKEN, {
  polling: true
});

loadUsers();

telegramClient.on('message', message => {
  const user = {
    chatId: message.chat.id,
    username: message.chat.username
  };

  for (const userToken in users) {
    if (users[userToken].username === message.chat.username) {
      telegramClient.sendMessage(message.chat.id, `Welcome back! Your access token is \n${userToken}`);

      return false;
    }
  }

  console.log('Adding', message.chat.username, 'to users.');

  const token = generate();

  users[token] = user;

  storeUser(token, user);

  telegramClient.sendMessage(message.chat.id, `Congrats! You are now added to the bot. Use the token \n${token}\n to authenticate.`);

  return true;
});

app.listen(process.env.PORT || DEFAULT_PORT, () => {
  console.log('Service up and running on port', process.env.PORT || DEFAULT_PORT);
});
