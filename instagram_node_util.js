// command line tool to read instagram follower counts
// based on:
// https://www.smashingmagazine.com/2017/03/interactive-command-line-application-node-js/

const program = require('commander');
const csv = require('csv');
const fs = require('fs');
const axios = require('axios');
const { readCsvAndMergeCounts } = require('./parser.js');

// Minimum occurances count to fetch.
const minCountToFetch = 2;
// minimu follower threshold for text output exports.
const textOutputFetchMinimumFollowers = 0; // save them all so we dont' have ot keep refetching.
// How often to write csv file.
const writeFrequency = 1000;
// delay between reads
let sleepTime = 3000;
// factor if timeout occurs. 1.0 means no increase in delay.
let timeoutIncreaseOffset = 300;

// how long to sleep when timeout occurs.
const timeoutSleep = 1000*60*3;

let fetchedUsers = 0;

program
  .version('0.0.1')
  .option('-o, --outputdir [dir]', 'csv file with "account:count" rows', './data')
  .option('-l, --list [list]', 'csv file with "account:count" rows')
  .option('-g, --list_generated [list_generated]', "list of csv files comma separated, previously generated by this program")
  .option('-t, --text_output [text_output]', "list of csv files, comma separated, output CSV file with text training data", true)
  .option('-c, --customimport [csv]', "csv file for explicit imports, if set other imports are ignored.")
  .option('-a, --accountnames', "If true converts realname->accountname.", false)
  .parse(process.argv)

let writeArray = [];

// Generates a comma delimited string from account object using keys in csvColumns Array.
function _accountToCsv(account, csvColumns) {
  let csvArray = [];
  for (const value of csvColumns) {
    csvArray.push(account[value]);
  }
  return csvArray.join(',');
}

// First row to emit in csv, column names.
const csvColumns = ['name','count','followers','likes','engagement','comments','id','videoFraction','videoViews'];

// First row to emit in text csv, column names.
const csvColumnsText = ['name','followers','biography','external_url','full_name',
'profile_pic_url_hd','profile_pic_url','caption_0','caption_1','caption_2','caption_3',
'caption_4','caption_5','caption_6','caption_7','caption_8','caption_9','caption_10','caption_11'];

// Creater dir',' if it does not exist.
function createDirIfNotExists(dirName) {
  if (!fs.existsSync(dirName)){
    fs.mkdirSync(dirName);
    console.info(`created directory: ${dirName}.`);
  }
}

// Fetches user with retry. If it's a permanent error like 404',' returns false.
// If it's a temp error like connection problem, retries infinitely.
// Don't write this record if a 404 occurs.
async function fetchDataWithRetry(name, account) {
  // Retry with backoff.
  let retryConnect = true;
  let fetchedData = false;
  let retryDelay = sleepTime;
  while (retryConnect) {
    try {
      retryConnect = false;
      // Enable to do realname->account conversion using the Search function.
      if (program.accountnames) {
        await getAccountFromName(name, account);
      } else {
        await processAccount(name, account);
      }

      fetchedUsers += 1;
      fetchedData = true;
    } catch (error) {
      counters.fetchErrors += 1;

      // 429 is too many connections, increase timeout.
      if (error.status == '429' || error.status == 429) {
        sleepTime += timeoutIncreaseOffset;
        console.error(new Date().toLocaleString(),
          'fetch error, increasing delay, retrying. ',
          error.code, error.status, sleepTime, name, error);
        retryConnect = true;
        // sleep 3 minutes
        await sleep(timeoutSleep);
      } else {
        // Connection problems not related to throttling.
        switch(error.code) {
          case 'ENOTFOUND': // internet died
          case 'ECONNRESET': // internet connection died
          case 'ECONNABORTED': // timeout
            retryConnect = true;
            console.warn('connection problem, retrying with backoff..');
            retryDelay *= 2.0;
            retryDelay = Math.min(retryDelay, 120*1000);
            break;
          // other problem not related to connection, ie 404,
          default:
            console.error('unknown error, skipping user', error);
            break;
        }
      }
    }
    await sleep(retryDelay);
  }
  return fetchedData;
}

// Check these fields for refreshing non-textual data.
const checkFieldsRefresh = ['followers','likes','engagement','comments'];

// Check these fields for refreshing textual data.
const checkFieldsRefreshTextual = ['biography','external_url','full_name'];

// Returns true if data is invalid, undefined and needs to be fetched.
function needsRefetchData(account, fields) {
  for (const field of fields) {
    const value = account[field];
    if (
      value == undefined ||
      value == 'undefined' ||
      value == NaN ||
      value == 'NaN')
      return true;
  }
}

const counters = {
  total: 0,
  skipped_minCount: 0,
  skipped_cr: 0,
  skipped_permanent_error: 0,
  skipped_textOutMinFollowers: 0,
  fetch_tried: 0,
  fetch_skipped: 0,
  fetch_success: 0,
  wrote_success: 0,
  fetchErrors: 0,
}
async function updateMissingCounters(accountDict) {
  createDirIfNotExists(`${program.outputdir}`);

  // Add column decriptiors to csv
  writeArray.push(csvColumns.join(','));
  writeCounter = 0;
  textBlobs = [];

  // Iterate and update records that are missing data.
  for (let name in accountDict) {
    counters.total += 1;
    let account = accountDict[name];
    account.fetch_name = name;
    let count = account.count;

    // Skip acounts with insufficient count, or with :cr suffix.
    if (count < minCountToFetch || name.indexOf(':cr') !== -1) {
      counters.skipped_minCount += 1;
      continue;
    }
    if (name.indexOf(':cr') !== -1) {
      counters.skipped_cr += 1;
      continue;
    }
    // console.log('checking object with fields:', name, Object.keys(account));

    // if we're exporting text, set a follower threshold.
    if (program.text_output &&
      (account.followers && account.followers < textOutputFetchMinimumFollowers)) {
        counters.skipped_textOutMinFollowers += 1;
      continue;
    }

    // Check if this account needs to be refreshed because of invalid, missing data, or
    // because it has never been fetched.
    let needsRefresh = needsRefetchData(account, checkFieldsRefresh);
    // Optionally check for textual data refresh.
    if (!needsRefresh && program.text_output ) {
      needsRefresh |= needsRefetchData(account, checkFieldsRefreshTextual);
    }

    // Refetch if data isn't present.
    let shouldSaveData = true;
    if (needsRefresh) {
      process.stdout.write(`fetching ${name}... `, );

      // console.log('fetching object with fields:', name, Object.keys(account));
      counters.fetch_tried += 1;
      shouldSaveData = await fetchDataWithRetry(name, account);
      counters.fetch_success += 1;
    } else {
      counters.fetch_skipped += 1;
      console.log(`skipping already fetched ${name}... `, );
    }

    // Don't write this record an error like 404 occured.
    if (!shouldSaveData) {
      counters.skipped_permanent_error += 1;
      continue;
    }

    // Add CSV row for non-textual data.
    account.name = name;
    writeArray.push(_accountToCsv(account, csvColumns));
    counters.wrote_success += 1;
    writeCounter -= 1;

    if (program.accountnames) {
      // For first row, add the column names.
      if (textBlobs.length == 0) {
        textBlobs.push(Object.keys(account).join(','));
      }
      textBlobs.push(_accountToCsv(account, Object.keys(account)));
    }

    // Add CSV row for textual data.
    if (program.text_output) {
      // For first row, add the column names.
      if (textBlobs.length == 0) {
        textBlobs.push(csvColumnsText.join(','));
      }
      textBlobs.push(_accountToCsv(account, csvColumnsText));
    }

    if (writeCounter <= 0) {
      console.log('saving checkpoint:\n', counters);

      version = writeArray.length;
      writeCsv(`${program.outputdir}/out${version}.csv`, writeArray.join('\n'));
      writeCounter = writeFrequency;
      if (program.text_output) {
        // also write text blobs
        writeCsv(`${program.outputdir}/outText${version}.csv`, textBlobs.join('\n'));
      }
    }
  }
  version = writeArray.length;
  writeCsv(`${program.outputdir}/out${version}_final.csv`, writeArray.join('\n'));
  console.log(`complete. fetched ${fetchedUsers} users.`)
  console.log(counters);
  if (program.text_output) {
    // also write text blobs
    writeCsv(`${program.outputdir}/outText${version}_final.csv`, textBlobs.join('\n'));
  }
}

async function sleep(ms){
  return new Promise((resolve) => setTimeout(resolve, ms));
};

async function writeCsv(filename, data) {
  return await fs.writeFile(filename, data, 'utf8', function (err) {
    if (err) {
      console.log('Some error occured - file either not saved or corrupted file saved.');
    } else{
      console.log('Wrote ', filename, fetchedUsers);
    }
  });
}

async function getFbData(username, url) {
  let response = undefined;
  try {
    response = await axios.get(url, {
      timeout: 2500,
    });
    process.stdout.write(`fetched (${fetchedUsers})\n`);
  } catch (error) {
    let status = 'not_available';
    if (error.response) {
      status = error.response.status;
    }
    let text = `getFbData axios failed: ${username}, (${error}) code:${error.code} status:${status}`;
    console.error(text);
    let newError = new Error(text);
    newError.code = error.code; // connection error code, like 'ECONNABORTED' etc.
    newError.status = status;
    throw newError;
  }
  if (response.data == undefined || response.data == null) {
    error = new Error('response.data is invalid:' + response.data);
  }
  return response.data;
}

// Searches for an account name by a real name. Can retun nothing.
async function getAccountFromName(realName, account) {
  const name = realName.split(' ').join('+');
  const url = `https://www.instagram.com/web/search/topsearch/?context=blended&query=${name}`;
  let response = await getFbData(realName[0], url);
  // console.log('fetched:\n', JSON.stringify(response, null, 2));
  if (!response.users || response.users.length == 0) {
    console.log('no results for:', realName.join(' '));
    return false;
  }

  // Find the first verified user, assume it's the NFL player. Else, take the first player.
  let index = 0;
  for (const i in response.users) {
    if (response.users[i].user.is_verified) {
      console.log('found verified at', i);
      index = i;
      break;
    }
  }
  const userData = response.users[index].user;
  account.followers = userData.follower_count;
  account.username = userData.username;
  account.full_name = _replaceCommasOrReturnEmpty(userData.full_name);
  account.profile_pic_url = userData.profile_pic_url;
  account.is_verified = userData.is_verified;
  account.is_private = userData.is_private;
  account.id = userData.pk;
  console.log('fetched account:', account);
  return true;
}

async function processAccount(accountName, account) {
  var url = "https://www.instagram.com/" + accountName + "/?__a=1";

  let response = await getFbData(accountName);
  // console.log('fetched:\n', JSON.stringify(response, null, 2));
  const userData = response.graphql.user;

  let followers = getInstagramFollowerCount(userData);
  let likes = getInstagramLikesCount(userData).toFixed(0);
  let engagement = 0;

  // Fraction of media that is videos (0 to 1).
  account.videoFraction = getMediaVideoPercentage(userData);
  account.videoViews = getInstagramVideoViewsCount(userData);

  if (followers > 0) {
    engagement = (likes / followers * 100).toFixed(2);
  }

  account.followers = followers;
  account.likes = likes;
  account.engagement = engagement;

  account.comments = getInstagramCommentsCount(userData).toFixed(0);

  if (program.text_output) {
    getInstagramCaptions(userData, account);
  }
  account.id = userData.id;
}


function getInstagramFollowerCount(user) {
  var count = user.edge_followed_by.count;
  return Number(count);
}

function getInstagramLikesCount(user) {
  return getMedianMediaCounts(user, 'edge_liked_by');
}

function getInstagramVideoViewsCount(user) {
  return getMedianMediaCounts(user, 'video_view_count');
}

function getInstagramCommentsCount(user) {
  return getMedianMediaCounts(user, 'edge_media_to_comment');
}

// Compute median of array of values.
function median(values) {
  if (values.length == 0) {
    return 0;
  }

  values.sort( function(a,b) {return a - b;} );
  var half = Math.floor(values.length/2);
  if(values.length % 2)
      return values[half];
  else
      return (values[half-1] + values[half]) / 2.0;
}

// Returns percentile of media that are cideos.
function getMediaVideoPercentage(user) {
  let videoCount = 0;
  const nodes = user.edge_owner_to_timeline_media.edges;
  for (var i = 0; i  < nodes.length; i++) {
    videoCount += nodes[i].node.is_video;
  }
  if (videoCount == 0) {
    return 0;
  };
  return videoCount / nodes.length;
}

// Retruns median for a counter like likes, comments or video views.
function getMedianMediaCounts(user, type) {
  let counts = [];
  const nodes = user.edge_owner_to_timeline_media.edges;

  if (nodes.length == 0) {
    return 0;
  }

  for (var i = 1; i  < nodes.length; i++) {
    var node = nodes[i].node;
    if (node == null) {
      continue;
    }
    let count = 0;
    if (type == 'video_view_count') {
      count = node[type];
    } else {
      count = node[type].count;
    }
    if (count != undefined) {
      counts.push(count);
    }
  }
  return median(counts);
}

function _replaceCommasOrReturnEmpty(text) {
  /*
  let encoded = encodeURI(text);
  console.log(encoded);
  return encoded;
  */

  if (text == undefined || text == null) {
    return '';
  }

  // strip commas
  const commaReplacement = '¸';
  const regexComma = /,/ig;
  let result = text.replace(regexComma, commaReplacement);

  // strip linebreaks
  const linebreakRegex = /\r?\n|\r/g;
  result = result.replace(linebreakRegex, ' ');
  return result;
}

// Collects text fields including comment captions, urls, names, anything we can use
// for analysis.
function getInstagramCaptions(user, textBlob) {
  let samples = 0;
  let captionNum = 0;

  textBlob.biography = _replaceCommasOrReturnEmpty(user.biography);
  textBlob.external_url = _replaceCommasOrReturnEmpty(user.external_url);
  textBlob.full_name = _replaceCommasOrReturnEmpty(user.full_name);
  textBlob.profile_pic_url_hd = _replaceCommasOrReturnEmpty(user.profile_pic_url_hd);
  textBlob.profile_pic_url = _replaceCommasOrReturnEmpty(user.profile_pic_url);
  // TODO: Read and ignore private accounts in original fetcher
  // TODO: Read video views. Right now account with videos only get thronw out
  // because they show 0 likes and 0 media.
  const nodes = user.edge_owner_to_timeline_media.edges;
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i].node;
    if (node == null) {
      continue;
    }
    if (node.edge_media_to_caption.edges.length == 0) {
      continue;
    }
    text = node.edge_media_to_caption.edges[0].node.text;
    textBlob['caption_' + captionNum] = _replaceCommasOrReturnEmpty(text);
    captionNum++;
  }
}

// Main.
async function main() {
  let dictCounts = {};

  // if customimport is set, ignore everything else.
  if (program.customimport) {
    try {
      await readCsvAndMergeCounts(
        program.customimport,
        dictCounts,
        undefined,
        100000,
      );
      await updateMissingCounters(dictCounts);
      return;
    } catch (error) {
      console.log('error loading', program.customimport, error);
      return;
    }
  }

  // Read the raw counst table first, output from crawler
  const columnNames = 'name,count';
  const csvpath = program.list;
  try {
    await readCsvAndMergeCounts(
      csvpath,
      dictCounts,
      columnNames.split(','),
      2500000,
    );
  } catch (error) {
    console.log('error loading program.list', csvpath, error);
    return;
  }

  if (program.list_generated) {
    const files = program.list_generated.split(',');
    for (const file of files) {
      try {
        await readCsvAndMergeCounts(
          file,
          dictCounts,
          undefined,
          250000,
        );
      } catch (error) {
          console.log('error loading', file, error);
          return;
      }
    }
  }

  if (program.text_output) {
    try {
      const files = program.text_output.split(',');
      for (const file of files) {
        await readCsvAndMergeCounts(
          file,
          dictCounts,
          undefined,
          250000,
        );
      }
    } catch (error) {
      console.error('error loading. Continuing normally. Some data abandoned.', error);
    }
  }
  // Start crawl.
  await updateMissingCounters(dictCounts);
}

main();
