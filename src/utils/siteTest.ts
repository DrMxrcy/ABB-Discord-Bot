import axios from 'axios';
import { logger } from '../bot.ts'; 

/**
 * Function to test if the site is up or down.
 * It sends a GET request to the site and checks the response status.
 * If the status is 200, 201, or 202, it logs that the site is up and returns true.
 * If the status is anything else, it logs that the site is down or redirecting and returns false.
 * If there's an error with the request, it logs the error and returns false.
 */
export async function siteTest(): Promise<boolean> {
  const url = process.env.AUDIOBOOK_BAY_URL;
  if (!url) {
    logger.error('AUDIOBOOK_BAY_URL is not defined');
    return false;
  }
  
  try {
    const response = await axios.get(url);
    if (response.status === 200) {
      logger.info(`${url} is up!!`);
      return true;
    }
  } catch (error) {
    logger.error(`Error checking site: ${error}`);
  }
  return false;
}