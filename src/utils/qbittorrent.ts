import { logger } from '../bot.ts'; 
import { QBittorrent } from '@ctrl/qbittorrent';
import dotenv from "dotenv";
import { exec as execCb } from 'child_process';
import { Client, ButtonInteraction } from 'discord.js';
import { senddownloadEmbed, senddownloadcompleteDM } from './sendEmbed.ts';
import { promisify } from 'util';
import { QBittorrentConfig, Task, TorrentData, AllData, DownloadingData, ExecResult } from '../interface/qbittorrent.interface';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Fetching environment variables for QBittorrent configuration
const QBITTORRENT_HOST = process.env.QBITTORRENT_HOST!;
const QBITTORRENT_USERNAME = process.env.QBITTORRENT_USERNAME!;
const QBITTORRENT_PASSWORD = process.env.QBITTORRENT_PASSWORD!;
const USE_PLEX = process.env.USE_PLEX;
const QBITTORRENT_COMPLETED_PATH = process.env.QBITTORRENT_COMPLETED_PATH;

// Checking if the required environment variables are defined
if (!QBITTORRENT_HOST || !QBITTORRENT_USERNAME || !QBITTORRENT_PASSWORD) {
  // Logging an error message if any of the required environment variables are not defined
  logger.error('Environment variables QBITTORRENT_HOST, QBITTORRENT_USERNAME, or QBITTORRENT_PASSWORD are not defined');
}

let PLEX_HOST: string | undefined, PLEX_TOKEN: string | undefined, PLEX_LIBRARY_NUM: string | undefined;

// If USE_PLEX is set to 'true', fetch and check for the other PLEX related environment variables
if (USE_PLEX === 'TRUE') {
  PLEX_HOST = process.env.PLEX_HOST;
  PLEX_TOKEN = process.env.PLEX_TOKEN;
  PLEX_LIBRARY_NUM = process.env.PLEX_LIBRARY_NUM;

  if (!PLEX_HOST || !PLEX_TOKEN || !PLEX_LIBRARY_NUM) {
    logger.error('Environment variables PLEX_HOST, PLEX_TOKEN, or PLEX_LIBRARY_NUM are not defined');
  } else {
    // Ensure PLEX_HOST ends with a slash
    if (!PLEX_HOST.endsWith('/')) {
      PLEX_HOST += '/';
    }
  }
}

// Add validation check with other env checks
if (QBITTORRENT_COMPLETED_PATH) {
  // Ensure path exists
  if (!fs.existsSync(QBITTORRENT_COMPLETED_PATH)) {
    try {
      fs.mkdirSync(QBITTORRENT_COMPLETED_PATH, { recursive: true });
    } catch (error) {
      logger.error(`Failed to create completed downloads directory: ${error}`);
    }
  }
}

// Creating a configuration object for QBittorrent
const config: QBittorrentConfig = {
  baseUrl: QBITTORRENT_HOST,
  username: QBITTORRENT_USERNAME,
  password: QBITTORRENT_PASSWORD,
};

// Creating a new instance of QBittorrent with the defined configuration
export const qbittorrent = new QBittorrent(config);

// Function to download a magnet link using QBittorrent
export async function downloadMagnet(magnet: string) {
  try {
    // Fetching the optional category environment variable
    const category = process.env.QBITTORRENT_CATEGORY;

    // Creating options object for addMagnet
    const options: { category?: string } = {};
    if (category) {
      options.category = category;
    }

    // Attempting to add the magnet link to QBittorrent with the optional category
    await qbittorrent.addMagnet(magnet, options);
  } catch (error) {
    // Checking if the error is a known "sticky magnet" error
    if (error instanceof Error && error.message.includes('torrents/add": <no response>')) {
      // Logging the error message if it's a known "sticky magnet" error
      logger.error(`Sticky magnet: should still work - ${error.message}`);
    } else {
      // If the error is not a known "sticky magnet" error, rethrowing it
      throw error;
    }
  }
}

// Class to manage a queue of tasks
class TaskQueue {
  // Array to hold the tasks
  private tasks: Array<Task>;
  // Boolean to indicate if a task is currently being processed
  private isProcessing: boolean;

  constructor() {
    // Initialize the tasks array and isProcessing flag
    this.tasks = [];
    this.isProcessing = false;
  }

  // Method to add a task to the queue
  addTask(task: Task): void {
    // Add the task to the tasks array
    this.tasks.push(task);
    // Process the tasks in the queue
    this.processTasks();
  }

  // Method to process the tasks in the queue
  private async processTasks(): Promise<void>  {
    // If a task is currently being processed or there are no tasks in the queue, return
    if (this.isProcessing || this.tasks.length === 0) {
      return;
    }

    // Set the isProcessing flag to true
    this.isProcessing = true;
    // Get the first task from the tasks array
    const task = this.tasks.shift();
    // If there is a task, execute it
    if (task) {
      await task();
    }
    // Set the isProcessing flag to false
    this.isProcessing = false;
    // Process the next task in the queue
    this.processTasks();
  }
}

// Create a new TaskQueue instance
const queue: TaskQueue = new TaskQueue();

// Create a new Map to hold the downloading data
const isDownloading: Map<string, DownloadingData> = new Map();

// Function to queue a user torrent
export function queueUserTorrent(userId: string, bookName: string, i: ButtonInteraction, magnetUrl: string): void {
  
  // Add a new task to the queue
  queue.addTask(async () => {
    try {
      // Get all the data from qbittorrent
      let allData = await qbittorrent.getAllData();
      // Store the current torrents
      let previousTorrents = allData.torrents;
      
      // Download the magnet URL
      await downloadMagnet(magnetUrl);

      // Log that we're waiting for a new torrent to appear
      logger.debug('Waiting for new torrent to appear...');

      // Loop until a new torrent appears
      while (true) {
        // Get the updated data from qbittorrent
        allData = await qbittorrent.getAllData();

        // If a new torrent has appeared, break the loop
        if (allData.torrents.length > previousTorrents.length) {
          break;
        }
      
        // Wait for a second before checking again
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Find the new torrent
      const newTorrent = allData.torrents.find(torrent => !previousTorrents.some(prevTorrent => prevTorrent.id === torrent.id));

      // If a new torrent was found, add it to the isDownloading map
      if (newTorrent) {
        const userData: DownloadingData = { userId, bookName, i, embedSent: false};
        isDownloading.set(newTorrent.id, userData);
      } else {
        // If no new torrent was found, log a message
        logger.info('No new torrent found');
      }
      // Log the number of items in the isDownloading map
      logger.debug('Number of items Downloading map: ' + isDownloading.size);
      // Send a download embed
      //senddownloadEmbed(i, userId, { name: bookName });
    } catch (error) {
      // If an error occurred, log it
      logger.error(`Error in queueUserTorrent: ${(error as Error).message}, Stack: ${(error as Error).stack}`);
    }
  });
}

// Promisify the exec function
const exec = promisify(execCb);

// Function to run a curl command
async function runCurlCommand(): Promise<void> {
  try {
    // Execute the curl command and get the stdout and stderr
    const { stdout, stderr }: ExecResult = await exec(`curl -s ${PLEX_HOST}library/sections/${PLEX_LIBRARY_NUM}/refresh?X-Plex-Token=${PLEX_TOKEN}`);
    
    // If there was an error, log it
    if (stderr) {
      logger.error(`Error refreshing Plex library: ${stderr}`);
      return;
    }
    // If there was output, log it
    if (stdout.trim() !== '') {
      logger.info(stdout);
    }
  } catch (error) {
    // If an error occurred, log it
    logger.error(`Error refreshing Plex library: ${(error as Error).message}, Stack: ${(error as Error).stack}`);
  }
}

// Add new function to handle moving files
async function moveCompletedDownload(torrentName: string, contentPath: string): Promise<void> {
  try {
    if (!QBITTORRENT_COMPLETED_PATH) {
      logger.debug('No completed path specified, skipping file move');
      return;
    }

    // Verify source path exists
    if (!fs.existsSync(contentPath)) {
      throw new Error(`Source path does not exist: ${contentPath}`);
    }

    const destinationPath = path.join(QBITTORRENT_COMPLETED_PATH, torrentName);
    
    // Create destination directory if it doesn't exist
    if (!fs.existsSync(path.dirname(destinationPath))) {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    }

    // Check if it's a directory or file
    const stats = fs.statSync(contentPath);
    if (stats.isDirectory()) {
      // For directories, we need to copy recursively
      fs.cpSync(contentPath, destinationPath, { recursive: true });
      // After successful copy, remove source
      fs.rmSync(contentPath, { recursive: true, force: true });
    } else {
      // For single files
      fs.copyFileSync(contentPath, destinationPath);
      fs.unlinkSync(contentPath);
    }

    logger.info(`Successfully moved completed download from ${contentPath} to ${destinationPath}`);
    return;
  } catch (error) {
    logger.error(`Failed to move completed download: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

// Function to handle downloads
export async function downloadHandler(client: Client, qbittorrent: QBittorrent): Promise<void> {
    // Load the cache when the program starts
    //const cache = loadCache();

    // Clear the isDownloading map and populate it with the cache data only if the cache is not empty
    //if (cache.size > 0) {
    //  isDownloading.clear();
    //  for (const [key, value] of cache.entries()) {
    //    isDownloading.set(key, value);
    //  }
    //}

  // Initialize the previous torrents array and the wasQueueEmpty flag
  let previousTorrents: TorrentData[] = [];
  let wasQueueEmpty = true;

  // Function to check the torrents
  const checkTorrents = async (): Promise<void> => {
    try {
      // Get all the data from qbittorrent
      const allData: AllData = await qbittorrent.getAllData();

      // Get the torrents from the data
      const torrents: TorrentData[] = allData.torrents;
  
      // Filter out torrents that were not added by this application
      const relevantTorrents = torrents.filter(torrent => isDownloading.has(torrent.id));
  
      // If there are no relevant torrents, log a message and set the wasQueueEmpty flag to true
      if (relevantTorrents.length === 0) {
        if (!wasQueueEmpty) {
          logger.info('No torrents in the queue. Waiting for new torrents.');
        }
        wasQueueEmpty = true;
        return;
      }
  
      // If there are relevant torrents, set the wasQueueEmpty flag to false
      wasQueueEmpty = false;
  
      // Create a promise for each relevant torrent
      const promises = relevantTorrents.map(async (torrent) => {
        try {
          const previousTorrent = previousTorrents.find(t => t.id === torrent.id);

          if (torrent.state === 'seeding' || torrent.state === 'completed') {
            if (!previousTorrent || (previousTorrent.state !== 'seeding' && previousTorrent.state !== 'completed')) {
              logger.info(`AudioBook: ${torrent.name} is complete. Processing...`);
              
              // Get the content path before removing from client
              const torrentInfo = await qbittorrent.getTorrent(torrent.id);
              
              if (!torrentInfo || !torrentInfo.content_path) {
                throw new Error(`Unable to get content path for torrent: ${torrent.name}`);
              }

              const contentPath = torrentInfo.content_path;

              // Move the completed download if path is configured
              if (QBITTORRENT_COMPLETED_PATH) {
                try {
                  await moveCompletedDownload(torrent.name, contentPath);
                  logger.info(`Successfully processed move for: ${torrent.name}`);
                } catch (moveError) {
                  logger.error(`Failed to move torrent ${torrent.name}: ${moveError instanceof Error ? moveError.message : 'Unknown error'}`);
                  // Don't remove the torrent if move failed
                  return;
                }
              }

              // Only proceed with removal if move was successful or not required
              if (USE_PLEX === 'TRUE' && PLEX_HOST && PLEX_TOKEN && PLEX_LIBRARY_NUM) {
                await runCurlCommand();
              }

              // Remove torrent only after successful move
              try {
                const result = await qbittorrent.removeTorrent(torrent.id, false);
                logger.info(`Removal result for ${torrent.name}: ${result}`);
              } catch (removeError) {
                logger.error(`Failed to remove torrent ${torrent.name}: ${removeError instanceof Error ? removeError.message : 'Unknown error'}`);
              }

              // Handle completion notification
              if (isDownloading.has(torrent.id)) {
                const userData = isDownloading.get(torrent.id)!;
                await senddownloadcompleteDM(client, userData.userId, { name: userData.bookName }, USE_PLEX);
                isDownloading.delete(torrent.id);
                logger.info('Number of items Downloading: ' + isDownloading.size);
              }
            }
          }
          // Add back the downloading state handling
          else if (torrent.state === 'downloading') {
            // If it's a new download or wasn't downloading before
            if (!previousTorrent || previousTorrent.state !== 'downloading') {
              if (isDownloading.has(torrent.id)) {
                const userData = isDownloading.get(torrent.id)!;
                logger.info(`Audiobook: ${userData.bookName} is downloading.`);
                if (!userData.embedSent) {
                  await senddownloadEmbed(userData.i, userData.userId, { name: userData.bookName });
                  userData.embedSent = true;
                }
                logger.info('Number of items Downloading: ' + isDownloading.size);
              }
            }
          }
        } catch (error) {
          logger.error(`Error processing torrent ${torrent.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      });
  
      // Wait for all the promises to resolve
      await Promise.all(promises);
      // Update the previous torrents array
      previousTorrents = relevantTorrents;
  
      // Save the cache after each check
      //saveCache(isDownloading);
    } catch (error) {
      // If an error occurred, log it
      logger.error(`Error while checking torrents: ${(error as Error).message}, Stack: ${(error as Error).stack}`);
    }
  };

  // Check the torrents every 10 seconds
  setInterval(checkTorrents, 10000); 
}

/*
// Define the path to the cache file
const cacheFilePath = path.resolve(__dirname, '../cache/isDownloadingCache.json');

// Ensure the directories exist
const dirPath = path.dirname(cacheFilePath);
fs.mkdirSync(dirPath, { recursive: true });

// Function to load the cache
function loadCache(): Map<string, DownloadingData> {
  const cache = new Map<string, DownloadingData>();
  try {
    // Check if the file exists and is not empty
    if (fs.existsSync(cacheFilePath) && fs.statSync(cacheFilePath).size > 0) {
      // Read the cache file
      const lines = fs.readFileSync(cacheFilePath, 'utf8').split('\n');
      // Parse each line and add it to the cache
      for (const line of lines) {
        if (line) {
          const [key, value] = JSON.parse(line);
          cache.set(key, value);
        }
      }
    }
  } catch (error) {
    // If an error occurred, log it and return an empty Map
    console.error('Error loading cache:', error);
  }
  return cache;
}

// Function to save the cache
function saveCache(isDownloading: Map<string, DownloadingData>): void {
  // Clear the cache file
  fs.writeFileSync(cacheFilePath, '');

  // Write each entry to the cache file
  for (const [key, value] of isDownloading.entries()) {
    // Convert the entry to a JSON object and stringify it
    const data = JSON.stringify([key, value]);
    // Append the data to the cache file
    fs.appendFileSync(cacheFilePath, data + '\n');
  }
}

// Save the cache when the program ends
process.on('exit', () => {
  logger.info('Program is exiting, saving cache');
  saveCache(isDownloading);
});
*/