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
import axios from 'axios';

dotenv.config();

// Fetching environment variables for QBittorrent configuration
const QBITTORRENT_HOST = process.env.QBITTORRENT_HOST!;
const QBITTORRENT_USERNAME = process.env.QBITTORRENT_USERNAME!;
const QBITTORRENT_PASSWORD = process.env.QBITTORRENT_PASSWORD!;
const USE_PLEX = process.env.USE_PLEX;
const QBITTORRENT_BASE_PATH = process.env.QBITTORRENT_BASE_PATH || '/mnt/unionfs/downloads/torrents/qbittorrent';
const QBITTORRENT_DOWNLOAD_PATH = path.join(QBITTORRENT_BASE_PATH, 'incoming');
const QBITTORRENT_COMPLETED_PATH = path.join(QBITTORRENT_BASE_PATH, 'completed');
const AUDIOBOOK_OUTPUT_PATH = process.env.AUDIOBOOK_OUTPUT_PATH || '/mnt/unionfs/Media/Audiobooks';

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

if (!QBITTORRENT_DOWNLOAD_PATH) {
  logger.warn('QBITTORRENT_DOWNLOAD_PATH not set, will rely on qBittorrent default path');
}

// Add validation for the paths
if (!fs.existsSync(QBITTORRENT_BASE_PATH)) {
  logger.error(`qBittorrent base path does not exist: ${QBITTORRENT_BASE_PATH}`);
}

// Ensure required directories exist
['incoming', 'completed', 'torrents', 'watched'].forEach(dir => {
  const dirPath = path.join(QBITTORRENT_BASE_PATH, dir);
  if (!fs.existsSync(dirPath)) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      logger.info(`Created directory: ${dirPath}`);
    } catch (error) {
      logger.error(`Failed to create directory ${dirPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
});

// Creating a configuration object for QBittorrent
const config: QBittorrentConfig = {
  baseUrl: QBITTORRENT_HOST,
  username: QBITTORRENT_USERNAME,
  password: QBITTORRENT_PASSWORD,
};

// Creating a new instance of QBittorrent with the defined configuration
export const qbittorrent = new QBittorrent({
  ...config,
  timeout: 10000, // 10 second timeout
  baseUrl: QBITTORRENT_HOST,
  username: QBITTORRENT_USERNAME,
  password: QBITTORRENT_PASSWORD,
});

// Initialize qBittorrent connection
export async function initializeQBittorrent(): Promise<void> {
  try {
    await qbittorrent.login(QBITTORRENT_USERNAME, QBITTORRENT_PASSWORD);
    logger.info('Successfully connected to qBittorrent');
  } catch (error) {
    logger.error(`Failed to initialize qBittorrent connection: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

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

// Add this new function to check for existing torrents
async function isTorrentAlreadyAdded(magnetUrl: string): Promise<{ exists: boolean; status: string }> {
  try {
    const allData = await qbittorrent.getAllData();
    const magnetHash = magnetUrl.split('btih:')[1]?.split('&')[0].toLowerCase();
    
    if (!magnetHash) {
      logger.warn('Could not extract hash from magnet URL');
      return { exists: false, status: 'unknown' };
    }

    const existingTorrent = allData.torrents.find(torrent => 
      torrent.id.toLowerCase() === magnetHash
    );

    if (existingTorrent) {
      // If torrent is completed but still in qBittorrent, it needs to be moved
      if (isTorrentReadyForProcessing(existingTorrent)) {
        try {
          // First check if it's already in the completed path
          if (QBITTORRENT_COMPLETED_PATH) {
            const allFiles = fs.readdirSync(QBITTORRENT_COMPLETED_PATH);
            if (allFiles.some(file => file.includes(magnetHash))) {
              // If it's already in completed path, just remove from qBittorrent
              await qbittorrent.removeTorrent(existingTorrent.id, false);
              logger.info(`Torrent already in completed path, removed from qBittorrent: ${existingTorrent.name}`);
              return { exists: true, status: 'already_downloaded' };
            }
          }

          // If not in completed path, try to move it
          try {
            const torrentInfo = await getTorrentInfoWithRetry(existingTorrent.id);
            if (torrentInfo && torrentInfo.content_path) {
              await moveCompletedDownload(existingTorrent.name, torrentInfo.content_path);
              await qbittorrent.removeTorrent(existingTorrent.id, false);
              logger.info(`Moved and removed completed torrent: ${existingTorrent.name}`);
              return { exists: true, status: 'already_downloaded' };
            } else {
              logger.warn(`Torrent info available but no content path for: ${existingTorrent.name}`);
              return { exists: true, status: 'completed_needs_attention' };
            }
          } catch (torrentError) {
            logger.error(`Failed to get torrent info: ${torrentError instanceof Error ? torrentError.message : 'Unknown error'}`);
            // If we can't get the torrent info, try to remove the torrent
            try {
              await qbittorrent.removeTorrent(existingTorrent.id, false);
              logger.info(`Removed problematic torrent: ${existingTorrent.name}`);
            } catch (removeError) {
              logger.error(`Failed to remove problematic torrent: ${removeError instanceof Error ? removeError.message : 'Unknown error'}`);
            }
            return { exists: true, status: 'completed_needs_attention' };
          }
        } catch (error) {
          logger.error(`Error handling completed torrent: ${error instanceof Error ? error.message : 'Unknown error'}`);
          return { exists: true, status: 'completed_needs_attention' };
        }
      }

      const status = isTorrentReadyForProcessing(existingTorrent) ? 'completed' : 
                    existingTorrent.state === 'downloading' ? 'downloading' : 
                    'queued';
      
      logger.info(`Torrent with hash ${magnetHash} is already ${status}`);
      return { exists: true, status };
    }

    // Check completed path if configured
    if (QBITTORRENT_COMPLETED_PATH) {
      const allFiles = fs.readdirSync(QBITTORRENT_COMPLETED_PATH);
      if (allFiles.some(file => file.includes(magnetHash))) {
        logger.info(`Torrent with hash ${magnetHash} was previously downloaded`);
        return { exists: true, status: 'already_downloaded' };
      }
    }

    return { exists: false, status: 'not_found' };
  } catch (error) {
    logger.error(`Error checking for existing torrent: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return { exists: false, status: 'error' };
  }
}

// Function to queue a user torrent
export function queueUserTorrent(userId: string, bookName: string, i: ButtonInteraction, magnetUrl: string): void {
  queue.addTask(async () => {
    try {
      const { exists, status } = await isTorrentAlreadyAdded(magnetUrl);
      
      if (exists) {
        let message = '';
        switch (status) {
          case 'downloading':
            message = `This audiobook is currently downloading!`;
            break;
          case 'completed':
            message = `This audiobook has finished downloading and is being moved to your library...`;
            break;
          case 'completed_needs_move':
            message = `This audiobook has finished downloading but needs manual attention to move to your library.`;
            break;
          case 'completed_needs_attention':
            message = `This audiobook has finished downloading but requires administrator attention.`;
            break;
          case 'queued':
            message = `This audiobook is queued for download!`;
            break;
          case 'already_downloaded':
            message = `This audiobook has already been downloaded and is in your library!`;
            break;
          default:
            message = `This audiobook is already in the system!`;
        }

        logger.warn(`Torrent for "${bookName}" - status: ${status}`);
        await i.followUp({
          content: message,
          ephemeral: true
        });
        return;
      }

      // Get initial torrent list
      const initialData = await qbittorrent.getAllData();
      const initialTorrents = initialData.torrents;

      // Add the magnet link with proper configuration
      await downloadMagnet(magnetUrl);
      logger.info(`Added magnet link for ${bookName}`);

      // Wait for the torrent to appear in qBittorrent
      let newTorrent: TorrentData | undefined;
      let attempts = 0;
      const maxAttempts = 10;

      while (!newTorrent && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const currentData = await qbittorrent.getAllData();
        
        newTorrent = currentData.torrents.find(torrent => 
          !initialTorrents.some(initial => initial.id === torrent.id)
        );

        attempts++;
        logger.debug(`Waiting for torrent to appear, attempt ${attempts}/${maxAttempts}`);
      }

      if (!newTorrent) {
        throw new Error('Failed to find newly added torrent');
      }

      // Add to downloading map
      const userData: DownloadingData = {
        userId,
        bookName,
        i,
        embedSent: false
      };

      isDownloading.set(newTorrent.id, userData);
      logger.info(`Successfully queued ${bookName} for download. Active downloads: ${isDownloading.size}`);

      // Initial download notification will be handled by the download handler
    } catch (error) {
      logger.error(`Failed to queue torrent: ${error instanceof Error ? error.message : 'Unknown error'}`);
      await i.followUp({
        content: 'Failed to start download. Please try again or contact administrator.',
        ephemeral: true
      });
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
    if (!AUDIOBOOK_OUTPUT_PATH) {
      logger.warn('AUDIOBOOK_OUTPUT_PATH not set, skipping move operation');
      return;
    }

    logger.info(`Starting move operation for ${torrentName}`);
    logger.debug(`Source path: ${contentPath}`);
    logger.debug(`Final destination path: ${AUDIOBOOK_OUTPUT_PATH}`);

    // Ensure source exists
    if (!fs.existsSync(contentPath)) {
      throw new Error(`Source path does not exist: ${contentPath}`);
    }

    const stats = fs.statSync(contentPath);
    
    if (stats.isDirectory()) {
      // For directories, find audio files
      const files = fs.readdirSync(contentPath);
      const audioFiles = files.filter(file => 
        file.toLowerCase().endsWith('.m4a') || 
        file.toLowerCase().endsWith('.mp3') || 
        file.toLowerCase().endsWith('.m4b')
      );

      if (audioFiles.length === 0) {
        throw new Error('No audio files found in torrent directory');
      }

      // Create author/book directory structure
      const destinationDir = path.join(AUDIOBOOK_OUTPUT_PATH, torrentName);
      if (!fs.existsSync(destinationDir)) {
        fs.mkdirSync(destinationDir, { recursive: true });
      }

      // Move each audio file
      for (const audioFile of audioFiles) {
        const sourcePath = path.join(contentPath, audioFile);
        const destPath = path.join(destinationDir, audioFile);
        
        logger.debug(`Moving audio file from ${sourcePath} to ${destPath}`);
        fs.copyFileSync(sourcePath, destPath);
      }

      // Remove source directory after successful copy
      fs.rmSync(contentPath, { recursive: true, force: true });
    } else {
      // For single files, check if it's an audio file
      const isAudioFile = contentPath.toLowerCase().endsWith('.m4a') || 
                         contentPath.toLowerCase().endsWith('.mp3') || 
                         contentPath.toLowerCase().endsWith('.m4b');

      if (!isAudioFile) {
        throw new Error('Downloaded file is not a supported audio format');
      }

      const destinationPath = path.join(AUDIOBOOK_OUTPUT_PATH, torrentName);
      const destinationDir = path.dirname(destinationPath);

      // Create directory if it doesn't exist
      if (!fs.existsSync(destinationDir)) {
        fs.mkdirSync(destinationDir, { recursive: true });
      }

      // Move the file
      logger.debug(`Moving single audio file to ${destinationPath}`);
      fs.copyFileSync(contentPath, destinationPath);
      fs.unlinkSync(contentPath);
    }

    logger.info(`Successfully moved ${torrentName} to ${AUDIOBOOK_OUTPUT_PATH}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to move completed download: ${errorMessage}`);
    logger.error(`Move operation failed for torrent: ${torrentName}`);
    logger.error(`Source path: ${contentPath}`);
    logger.error(`Destination path: ${AUDIOBOOK_OUTPUT_PATH}`);
    throw error;
  }
}

// Add authentication handling
async function ensureAuthenticated(): Promise<void> {
  try {
    // Try to get torrent list to check if we're authenticated
    await qbittorrent.listTorrents();
  } catch (error) {
    if (error instanceof Error && (error.message.includes('403') || error.message.includes('Forbidden'))) {
      logger.info('Session expired, re-authenticating...');
      try {
        // Login again
        await qbittorrent.login(QBITTORRENT_USERNAME, QBITTORRENT_PASSWORD);
        logger.info('Re-authentication successful');
      } catch (loginError) {
        logger.error(`Failed to re-authenticate: ${loginError instanceof Error ? loginError.message : 'Unknown error'}`);
        throw loginError;
      }
    } else {
      throw error;
    }
  }
}

// Update the isTorrentReadyForProcessing function with stricter checks
function isTorrentReadyForProcessing(torrent: TorrentData): boolean {
  const readyStates = [
    'uploading',     // Being seeded and data is being transferred
    'pausedUP',      // Paused and finished downloading
    'queuedUP',      // Queued for upload after completion
    'stalledUP',     // Seeding but no connections
    'checkingUP',    // Finished downloading and being checked
    'forcedUP',      // Forced uploading
    'seeding'        // Add explicit seeding state
  ];

  const hasValidState = readyStates.includes(torrent.state);
  const progress = torrent.progress || 0;
  const isFullyDownloaded = torrent.amount_left === 0;
  const hasCompletedTime = torrent.completion_on > 0;
  
  logger.debug(`Torrent ${torrent.name}:`);
  logger.debug(`- State: ${torrent.state}`);
  logger.debug(`- Progress: ${progress}`);
  logger.debug(`- Amount Left: ${torrent.amount_left}`);
  logger.debug(`- Completion Time: ${torrent.completion_on}`);
  logger.debug(`- Valid State: ${hasValidState}`);
  logger.debug(`- Is Fully Downloaded: ${isFullyDownloaded}`);
  logger.debug(`- Has Completion Time: ${hasCompletedTime}`);

  // Only consider ready if:
  // 1. Has a valid state
  // 2. Progress is 100%
  // 3. Amount left is 0
  // 4. Has a completion timestamp
  const isReady = hasValidState && 
                 progress >= 1 && 
                 isFullyDownloaded && 
                 hasCompletedTime;

  logger.debug(`- Ready for Processing: ${isReady}`);
  
  return isReady;
}

// Add a delay before processing completed torrents
async function waitForTorrentToSettle(torrent: TorrentData): Promise<void> {
  const settleTime = 5000; // 5 seconds
  logger.debug(`Waiting ${settleTime}ms for torrent to settle: ${torrent.name}`);
  await new Promise(resolve => setTimeout(resolve, settleTime));
}

// Update getTorrentInfoWithRetry to use more generic path checking
async function getTorrentInfoWithRetry(torrentId: string, maxRetries = 5, delayMs = 3000): Promise<any> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await ensureAuthenticated();
      
      const torrentInfo = await qbittorrent.getTorrent(torrentId);
      logger.debug(`Attempt ${attempt}: Got torrent info for ${torrentId}`);
      logger.debug(`Torrent info: ${JSON.stringify(torrentInfo)}`);

      if (torrentInfo) {
        // Try different methods to get the file path
        const possiblePaths = [
          // Direct paths
          torrentInfo.content_path,
          // Standard paths
          path.join(QBITTORRENT_COMPLETED_PATH, torrentInfo.name),
          // From save path
          torrentInfo.save_path ? path.join(torrentInfo.save_path, torrentInfo.name) : null,
          // Search in completed directory
          ...searchCompletedDirectory(torrentInfo.name)
        ].filter(Boolean);

        // Log all possible paths we're checking
        logger.debug('Checking possible paths:');
        possiblePaths.forEach(p => logger.debug(`- ${p}`));

        // Try each possible path
        for (const possiblePath of possiblePaths) {
          logger.debug(`Checking path: ${possiblePath}`);
          if (possiblePath && fs.existsSync(possiblePath)) {
            // Check if it's a directory and contains audio files
            if (fs.statSync(possiblePath).isDirectory()) {
              const files = fs.readdirSync(possiblePath);
              const hasAudioFiles = files.some(file => 
                file.toLowerCase().endsWith('.m4a') || 
                file.toLowerCase().endsWith('.mp3') || 
                file.toLowerCase().endsWith('.m4b')
              );
              if (hasAudioFiles) {
                logger.debug(`Found valid path with audio files: ${possiblePath}`);
                torrentInfo.content_path = possiblePath;
                return torrentInfo;
              }
            } else if (possiblePath.match(/\.(m4a|mp3|m4b)$/i)) {
              logger.debug(`Found valid audio file: ${possiblePath}`);
              torrentInfo.content_path = possiblePath;
              return torrentInfo;
            }
          }
        }

        logger.debug(`No valid path found on attempt ${attempt}, waiting...`);
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown error');
      logger.debug(`Attempt ${attempt}/${maxRetries} failed: ${lastError.message}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  const errorMsg = `Failed to get torrent info after ${maxRetries} attempts: ${lastError?.message || 'Torrent info not available'}`;
  logger.error(errorMsg);
  throw new Error(errorMsg);
}

// Update searchCompletedDirectory to be more thorough
function searchCompletedDirectory(torrentName: string): string[] {
  const paths: string[] = [];
  if (!QBITTORRENT_COMPLETED_PATH) return paths;

  try {
    const dirs = fs.readdirSync(QBITTORRENT_COMPLETED_PATH);
    for (const dir of dirs) {
      const fullPath = path.join(QBITTORRENT_COMPLETED_PATH, dir);
      if (fs.statSync(fullPath).isDirectory()) {
        // Check if directory name contains the torrent name (case insensitive)
        if (dir.toLowerCase().includes(torrentName.toLowerCase())) {
          paths.push(fullPath);
        }
        // Also check subdirectories
        try {
          const subDirs = fs.readdirSync(fullPath);
          for (const subDir of subDirs) {
            const subPath = path.join(fullPath, subDir);
            if (fs.statSync(subPath).isDirectory() && 
                subDir.toLowerCase().includes(torrentName.toLowerCase())) {
              paths.push(subPath);
            }
          }
        } catch (subError) {
          logger.debug(`Error reading subdirectory ${fullPath}: ${subError instanceof Error ? subError.message : 'Unknown error'}`);
        }
      }
    }
  } catch (error) {
    logger.error(`Error searching completed directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  return paths;
}

// Function to handle downloads
export async function downloadHandler(client: Client, qbittorrent: QBittorrent): Promise<void> {
  try {
    await initializeQBittorrent();
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
      await ensureAuthenticated();
      const allData: AllData = await qbittorrent.getAllData();
      const torrents: TorrentData[] = allData.torrents;

      // Log all torrents and their states
      torrents.forEach(torrent => {
        logger.debug(`Found torrent: ${torrent.name} (${torrent.id})`);
        logger.debug(`- State: ${torrent.state}`);
        logger.debug(`- Progress: ${torrent.progress}`);
      });

      const relevantTorrents = torrents.filter(torrent => isDownloading.has(torrent.id));
      logger.debug(`Found ${relevantTorrents.length} relevant torrents`);

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
          logger.debug(`Processing torrent: ${torrent.name}`);
          logger.debug(`Current state: ${torrent.state}, Previous state: ${previousTorrent?.state}`);

          if (isTorrentReadyForProcessing(torrent)) {
            logger.info(`Torrent ${torrent.name} is ready for processing`);
            if (!previousTorrent || !isTorrentReadyForProcessing(previousTorrent)) {
              // Add delay before processing
              await waitForTorrentToSettle(torrent);
              
              // Check again after waiting to ensure torrent is still ready
              const currentTorrentInfo = await qbittorrent.getTorrent(torrent.id);
              if (!currentTorrentInfo || !isTorrentReadyForProcessing(currentTorrentInfo)) {
                logger.debug(`Torrent ${torrent.name} not ready after settling time, will try again later`);
                return;
              }

              logger.info(`AudioBook: ${torrent.name} is complete. Processing...`);
              
              try {
                // Use the new retry function
                const torrentInfo = await getTorrentInfoWithRetry(torrent.id);
                
                if (!torrentInfo || !torrentInfo.content_path) {
                  throw new Error(`Unable to get content path for torrent: ${torrent.name}`);
                }

                const contentPath = torrentInfo.content_path;
                logger.debug(`Content path for ${torrent.name}: ${contentPath}`);

                // Move the completed download if path is configured
                if (AUDIOBOOK_OUTPUT_PATH) {
                  try {
                    await moveCompletedDownload(torrent.name, contentPath);
                    logger.info(`Successfully processed move for: ${torrent.name}`);
                    
                    // Only proceed with Plex refresh after successful move
                    if (USE_PLEX === 'TRUE' && PLEX_HOST && PLEX_TOKEN && PLEX_LIBRARY_NUM) {
                      await runCurlCommand();
                    }

                    // Remove torrent only after successful move
                    await qbittorrent.removeTorrent(torrent.id, false);
                    logger.info(`Successfully removed torrent: ${torrent.name}`);

                    // Handle completion notification
                    if (isDownloading.has(torrent.id)) {
                      const userData = isDownloading.get(torrent.id)!;
                      await senddownloadcompleteDM(client, userData.userId, { name: userData.bookName }, USE_PLEX);
                      isDownloading.delete(torrent.id);
                      logger.info(`Completed processing for ${torrent.name}. Remaining downloads: ${isDownloading.size}`);
                    }
                  } catch (moveError) {
                    logger.error(`Failed to process completed download for ${torrent.name}: ${moveError instanceof Error ? moveError.message : 'Unknown error'}`);
                    // Don't proceed with removal if move failed
                    return;
                  }
                }
              } catch (error) {
                logger.error(`Error processing completed torrent ${torrent.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
              }
            }
          } else {
            logger.debug(`Torrent ${torrent.name} is not ready for processing yet`);
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
      if (error instanceof Error) {
        // Don't log authentication retry attempts as errors
        if (!error.message.includes('403') && !error.message.includes('Forbidden')) {
          logger.error(`Error while checking torrents: ${error.message}, Stack: ${error.stack}`);
        }
      }
      // Wait a bit longer if we hit an error
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  };

  // Check the torrents more frequently during development
  const checkInterval = process.env.NODE_ENV === 'development' ? 5000 : 30000;
  setInterval(checkTorrents, checkInterval);
  } catch (error) {
    logger.error(`Failed to start download handler: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
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