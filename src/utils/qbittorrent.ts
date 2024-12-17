import { logger } from '../bot'; 
import { QBittorrent } from '@ctrl/qbittorrent';
import dotenv from "dotenv";
import { exec as execCb } from 'child_process';
import { Client } from 'discord.js';
import { senddownloadEmbed, senddownloadcompleteDM } from './sendEmbed';
import { promisify } from 'util';
import { QBittorrentConfig, Task, TorrentData, AllData, DownloadingData, ExecResult } from '../interface/qbittorrent.interface';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import NodeCache from 'node-cache';
import rateLimit from 'axios-rate-limit';

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

// Initialize cache with 24 hour TTL
const metadataCache = new NodeCache({ 
  stdTTL: 86400, // 24 hours in seconds
  checkperiod: 3600 // Check for expired entries every hour
});

// Create rate-limited axios instance
const axiosRateLimit = rateLimit(axios.create(), { 
  maxRequests: 2, // Maximum of 2 requests
  perMilliseconds: 1000, // Per second
  maxRPS: 2 // Rate limit of 2 requests per second
});

interface AudnexusMetadata {
  title: string;
  authors: Array<{
    name: string;
    role: string;
  }>;
  series?: {
    name: string;
    position: string;
  };
  narrators: string[];
  genres: string[];
  publishedYear?: number;
  asin?: string;
  duration?: string;
  region?: string;
  language?: string;
  description?: string;
  rating?: {
    average?: number;
    count?: number;
  };
}

async function getAudnexusMetadata(bookName: string): Promise<AudnexusMetadata | null> {
  try {
    // Generate cache key
    const cacheKey = `audnexus:${bookName.toLowerCase().trim()}`;

    // Check cache first
    const cachedData = metadataCache.get<AudnexusMetadata>(cacheKey);
    if (cachedData) {
      logger.debug(`Using cached metadata for: ${bookName}`);
      return cachedData;
    }

    // If not in cache, fetch from API with rate limiting
    logger.debug(`Fetching Audnexus metadata for: ${bookName}`);
    const response = await axiosRateLimit.get(`https://api.audnex.us/books/search`, {
      params: {
        q: bookName,
        limit: 1
      },
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'ABB-Discord-Bot/1.0'
      }
    });

    if (response.data && response.data.length > 0) {
      const metadata = response.data[0];
      
      // Store in cache
      metadataCache.set(cacheKey, metadata);
      
      // Log successful fetch
      logger.info(`Successfully fetched metadata for: ${bookName}`);
      logger.debug(`Metadata: ${JSON.stringify(metadata, null, 2)}`);
      
      return metadata;
    }

    // If no results found, cache null result to prevent repeated lookups
    metadataCache.set(cacheKey, null, 3600); // Cache miss for 1 hour
    logger.warn(`No metadata found for: ${bookName}`);
    return null;

  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 429) {
        logger.error(`Rate limit exceeded for Audnexus API: ${error.message}`);
      } else {
        logger.error(`Audnexus API error: ${error.message}`);
      }
    } else {
      logger.error(`Failed to fetch Audnexus metadata: ${error}`);
    }
    return null;
  }
}

// Add cache management functions
export function clearMetadataCache(): void {
  metadataCache.flushAll();
  logger.info('Metadata cache cleared');
}

export function getMetadataCacheStats(): {
  keys: number;
  hits: number;
  misses: number;
  ksize: number;
  vsize: number;
} {
  return metadataCache.getStats();
}

// Add new function to handle moving files
async function moveCompletedDownload(torrentName: string, contentPath: string, userData: DownloadingData): Promise<void> {
  try {
    if (!QBITTORRENT_COMPLETED_PATH) {
      logger.debug('No completed path specified, skipping file move');
      return;
    }

    // Try to get metadata from Audnexus
    const metadata = await getAudnexusMetadata(userData.bookName);
    let destinationPath: string;

    if (metadata) {
      const author = metadata.authors.find(a => a.role === 'author')?.name || 'Unknown Author';
      const narrator = metadata.narrators[0] || 'Unknown Narrator';
      const year = metadata.publishedYear ? `(${metadata.publishedYear})` : '';
      const language = metadata.language ? `[${metadata.language}]` : '';
      
      destinationPath = path.join(QBITTORRENT_COMPLETED_PATH, sanitizePath(author));

      if (metadata.series) {
        const seriesFolder = `${sanitizePath(metadata.series.name)} [${metadata.series.position}]`;
        destinationPath = path.join(destinationPath, seriesFolder);
      }

      const bookFolder = `${sanitizePath(metadata.title)} ${year} ${language} [${sanitizePath(narrator)}]`;
      destinationPath = path.join(destinationPath, bookFolder);

      // Create metadata files
      await createMetadataFiles(destinationPath, metadata);
    } else {
      // Fallback to basic parsing if no Audnexus metadata
      const bookInfo = parseBookName(userData.bookName);
      destinationPath = path.join(QBITTORRENT_COMPLETED_PATH, bookInfo.author);
      if (bookInfo.series) {
        destinationPath = path.join(destinationPath, bookInfo.series);
      }
      destinationPath = path.join(destinationPath, torrentName);
    }

    // Create directories if they don't exist
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

    // Move the content
    fs.renameSync(contentPath, destinationPath);
    logger.info(`Moved completed download to ${destinationPath}`);

  } catch (error) {
    logger.error(`Failed to move completed download: ${error}`);
    throw error;
  }
}

async function createMetadataFiles(destinationPath: string, metadata: AudnexusMetadata): Promise<void> {
  try {
    // Create book-info.json
    const metadataPath = path.join(destinationPath, 'book-info.json');
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    // Create NFO file for media players
    const nfoContent = generateNFO(metadata);
    const nfoPath = path.join(destinationPath, 'audiobook.nfo');
    fs.writeFileSync(nfoPath, nfoContent);

  } catch (error) {
    logger.error(`Failed to create metadata files: ${error}`);
  }
}

function generateNFO(metadata: AudnexusMetadata): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<audioBookInfo>
    <title>${metadata.title}</title>
    <author>${metadata.authors.find(a => a.role === 'author')?.name || 'Unknown'}</author>
    <narrator>${metadata.narrators.join(', ')}</narrator>
    ${metadata.series ? `<series>${metadata.series.name}</series>
    <seriesPosition>${metadata.series.position}</seriesPosition>` : ''}
    <year>${metadata.publishedYear || ''}</year>
    <genre>${metadata.genres.join(', ')}</genre>
    <description>${metadata.description || ''}</description>
    <duration>${metadata.duration || ''}</duration>
    <language>${metadata.language || ''}</language>
    ${metadata.rating ? `<rating>${metadata.rating.average || ''}</rating>
    <ratingCount>${metadata.rating.count || ''}</ratingCount>` : ''}
    <asin>${metadata.asin || ''}</asin>
</audioBookInfo>`;
}

function sanitizePath(str: string): string {
  return str
    .replace(/[<>:"/\\|?*]/g, '') // Remove invalid characters
    .replace(/\s+/g, ' ')         // Normalize spaces
    .trim();
}

interface BookInfo {
  author: string;
  series?: string;
  title: string;
}

function parseBookName(bookName: string): BookInfo {
  // Common patterns in audiobook names:
  // "Author Name - Series Name 01 - Book Title"
  // "Author Name - Book Title"
  
  const bookInfo: BookInfo = {
    author: "Unknown Author",
    title: bookName
  };

  try {
    // Split by " - "
    const parts = bookName.split(" - ");
    
    if (parts.length >= 2) {
      bookInfo.author = parts[0].trim();
      
      // Check if middle part contains series info (usually has numbers)
      if (parts.length === 3 && /\d/.test(parts[1])) {
        bookInfo.series = parts[1].trim();
        bookInfo.title = parts[2].trim();
      } else {
        bookInfo.title = parts[1].trim();
      }
    }

    // Clean up author name
    bookInfo.author = bookInfo.author.replace(/[<>:"/\\|?*]/g, '');
    
    // Clean up series name if it exists
    if (bookInfo.series) {
      bookInfo.series = bookInfo.series.replace(/[<>:"/\\|?*]/g, '');
    }
    
    // Clean up title
    bookInfo.title = bookInfo.title.replace(/[<>:"/\\|?*]/g, '');

  } catch (error) {
    logger.error(`Error parsing book name "${bookName}": ${error}`);
  }

  return bookInfo;
}

// Add retry utility
async function retry<T>(
  operation: () => Promise<T>,
  retries = 3,
  delay = 1000
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (retries > 0) {
      logger.warn(`Operation failed, retrying in ${delay}ms. Retries left: ${retries}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return retry(operation, retries - 1, delay * 2);
    }
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
        const previousTorrent = previousTorrents.find(t => t.id === torrent.id);

        if (torrent.state === 'seeding') {
          if (!previousTorrent || previousTorrent.state !== 'seeding') {
            logger.info(`AudioBook: ${torrent.name} is complete. Processing...`);
            
            try {
              // Get torrent info with retry
              const torrentInfo = await retry(() => qbittorrent.getTorrent(torrent.id));
              const contentPath = torrentInfo.state.downloadPath || torrentInfo.savePath;

              if (!contentPath) {
                throw new Error('Content path is undefined');
              }

              // Verify file exists before moving
              if (!fs.existsSync(contentPath)) {
                throw new Error(`Content path does not exist: ${contentPath}`);
              }

              // Move the completed download if path is configured
              if (QBITTORRENT_COMPLETED_PATH) {
                await moveCompletedDownload(torrent.name, contentPath, isDownloading.get(torrent.id)!);
                
                // Verify move was successful
                const userData = isDownloading.get(torrent.id)!;
                const bookInfo = parseBookName(userData.bookName);
                const expectedPath = path.join(QBITTORRENT_COMPLETED_PATH, bookInfo.author);
                
                if (!fs.existsSync(expectedPath)) {
                  throw new Error('Move operation failed - destination path does not exist');
                }
              }

              // Only remove from qBittorrent after successful move
              logger.info(`AudioBook: ${torrent.name} is complete. Removing from client.`);
              const result = await retry(() => qbittorrent.removeTorrent(torrent.id, false));
              logger.info(`Removal result for ${torrent.name}: ${result}`);

              // Trigger Plex scan after successful move
              if (USE_PLEX === 'TRUE' && PLEX_HOST && PLEX_TOKEN && PLEX_LIBRARY_NUM) {
                await runCurlCommand();
              }

              // Handle completion notifications
              if (isDownloading.has(torrent.id)) {
                const userData = isDownloading.get(torrent.id)!;
                if (!previousTorrent || previousTorrent.state !== 'seeding') {
                  await senddownloadcompleteDM(client, userData.userId, { name: userData.bookName }, USE_PLEX);
                }
                isDownloading.delete(torrent.id);
                logger.info('Number of items Downloading: ' + isDownloading.size);
              }

            } catch (error) {
              logger.error(`Failed to process completed download for ${torrent.name}: ${error}`);
              // Don't remove the torrent if processing failed
              return;
            }
          }
        }
        // If the torrent is downloading and it's a new download
        else if (!previousTorrent || (previousTorrent && previousTorrent.state !== 'downloading')) {
          // If the torrent is in the isDownloading map
          if (isDownloading.has(torrent.id)) {
            // Get the user data, log a message, send a download embed, and log the number of items in the map
            const userData = isDownloading.get(torrent.id)!;
            logger.info(`Audiobook: ${userData.bookName} is downloading.`);
            if (!userData.embedSent) {
              senddownloadEmbed(userData.i, userData.userId, { name: userData.bookName });
              userData.embedSent = true;
            }
            logger.info('Number of items Downloading: ' + isDownloading.size);
          }
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
      logger.error(`Error while checking torrents: ${error}`);
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