import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import readline from 'readline';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants
const PIXEL_DIFF_THRESHOLD = 0.1; // Allow some difference for dynamic content
const RESULT_DIR = path.join(__dirname, 'result');
const BASELINE_DIR = path.join(__dirname, 'baseline');

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Utility functions
function log(message) {
  console.log(message);
}

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

function ensureBaselineDir() {
  if (!fs.existsSync(BASELINE_DIR)) {
    fs.mkdirSync(BASELINE_DIR, { recursive: true });
  }
}

function getBaselineFolders() {
  if (!fs.existsSync(BASELINE_DIR)) {
    return [];
  }
  return fs.readdirSync(BASELINE_DIR).filter(item => {
    const itemPath = path.join(BASELINE_DIR, item);
    return fs.statSync(itemPath).isDirectory();
  });
}

function categorizeFolders(folders) {
  const categorized = {};
  folders.forEach(folder => {
    const parts = folder.split('-');
    if (parts.length >= 2) {
      const date = parts[parts.length - 1];
      const website = parts.slice(0, -1).join('-');
      if (!categorized[website]) {
        categorized[website] = [];
      }
      categorized[website].push(date);
    }
  });
  return categorized;
}

function createSafeFileName(url) {
  try {
    const urlObj = new URL(url);
    let filename = urlObj.hostname + urlObj.pathname;
    filename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    filename = filename.replace(/_+/g, '_');
    filename = filename.replace(/^_|_$/g, '');
    return filename || 'index';
  } catch {
    return 'invalid_url';
  }
}

// Add spinner utility functions
function showSpinner(message) {
  const spinnerChars = ['|', '/', '-', '\\'];
  let i = 0;
  return setInterval(() => {
    process.stdout.write(`\r${message} ${spinnerChars[i++ % spinnerChars.length]}`);
  }, 100);
}

function stopSpinner(interval, finalMessage) {
  clearInterval(interval);
  process.stdout.write(`\r${finalMessage}\n`);
}

// Add URL validation and domain extraction functions
function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch {
    return false;
  }
}

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function normalizeUrl(url, baseUrl) {
  try {
    // Handle relative URLs
    if (url.startsWith('/')) {
      const base = new URL(baseUrl);
      return `${base.protocol}//${base.host}${url}`;
    }
    if (url.startsWith('#')) {
      return null; // Skip anchor links
    }
    if (url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('javascript:')) {
      return null; // Skip non-http protocols
    }
    
    const fullUrl = new URL(url, baseUrl);
    // Remove fragment (hash)
    fullUrl.hash = '';
    return fullUrl.href;
  } catch {
    return null;
  }
}

function getPathDepth(url) {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(part => part.length > 0);
    return pathParts.length;
  } catch {
    return 0;
  }
}

// Add function to get local timestamp
function getLocalTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  
  return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}`;
}

async function crawlAndScreenshot(startUrl) {
  const domain = getDomain(startUrl);
  if (!domain) {
    throw new Error('Invalid starting URL');
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });

  const visitedUrls = new Set();
  const urlsToVisit = [startUrl];
  const pages = [];
  
  // Create baseline folder with local timestamp
  const timestamp = getLocalTimestamp();
  const safeDomain = domain.replace(/[^a-zA-Z0-9.-]/g, '_');
  const folderName = `${safeDomain}-${timestamp}`;
  const folderPath = path.join(BASELINE_DIR, folderName);
  
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  let spinner = showSpinner('Crawling and taking screenshots');

  while (urlsToVisit.length > 0) {
    const currentUrl = urlsToVisit.shift();
    
    if (visitedUrls.has(currentUrl)) {
      continue;
    }
    
    visitedUrls.add(currentUrl);
    
    try {
      stopSpinner(spinner, `Processing: ${currentUrl}`);
      spinner = showSpinner('Crawling and taking screenshots');

      // Navigate to page
      await page.goto(currentUrl, { timeout: 100000, waitUntil: 'networkidle' });
      
      // Get page info
      const title = await page.title();
      const canonical = await page.evaluate(() => {
        const canonicalElement = document.querySelector('link[rel="canonical"]');
        return canonicalElement ? canonicalElement.href : null;
      });

      // Take screenshot
      const fileName = createSafeFileName(currentUrl);
      const screenshotPath = path.join(folderPath, `${fileName}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      // Determine page type and depth
      const pathDepth = getPathDepth(currentUrl);
      const pageType = currentUrl === startUrl ? 'main' : 'sub';

      // Store page info
      const pageInfo = {
        url: currentUrl,
        type: pageType,
        pathDepth: pathDepth,
        path: new URL(currentUrl).pathname,
        status: 'success',
        title: title,
        screenshotPath: screenshotPath,
        errorMessage: null,
        canonical: canonical || currentUrl
      };
      
      pages.push(pageInfo);

      // Extract links from current page
      const links = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        return anchors.map(a => a.href);
      });

      // Process discovered links
      for (const link of links) {
        const normalizedUrl = normalizeUrl(link, currentUrl);
        if (normalizedUrl && 
            getDomain(normalizedUrl) === domain && 
            !visitedUrls.has(normalizedUrl) && 
            !urlsToVisit.includes(normalizedUrl)) {
          urlsToVisit.push(normalizedUrl);
        }
      }

    } catch (error) {
      // Handle errors - add failed page info and continue
      const fileName = createSafeFileName(currentUrl);
      const pageInfo = {
        url: currentUrl,
        type: currentUrl === startUrl ? 'main' : 'sub',
        pathDepth: getPathDepth(currentUrl),
        path: new URL(currentUrl).pathname,
        status: 'error',
        title: null,
        screenshotPath: null,
        errorMessage: error.message,
        canonical: currentUrl
      };
      
      pages.push(pageInfo);
      stopSpinner(spinner, `Error processing ${currentUrl}: ${error.message}`);
      spinner = showSpinner('Crawling and taking screenshots');
    }
  }

  await browser.close();
  stopSpinner(spinner, 'Crawling completed!');

  // Save pages.json
  const pagesJsonPath = path.join(folderPath, 'pages.json');
  fs.writeFileSync(pagesJsonPath, JSON.stringify(pages, null, 2));

  return {
    folderPath,
    totalPages: pages.length,
    successPages: pages.filter(p => p.status === 'success').length,
    errorPages: pages.filter(p => p.status === 'error').length
  };
}

async function baselineMenu() {
  log('\n=== Baseline Menu ===');
  const startUrl = await ask('Enter the starting URL to crawl: ');
  
  if (!isValidUrl(startUrl)) {
    log('Invalid URL provided. Returning to main menu.');
    await mainMenu();
    return;
  }

  try {
    ensureBaselineDir();
    
    log(`Starting baseline creation for: ${startUrl}`);
    const result = await crawlAndScreenshot(startUrl);
    
    log('\n=== Baseline Creation Complete ===');
    log(`Baseline saved to: ${result.folderPath}`);
    log(`Total pages processed: ${result.totalPages}`);
    log(`Successful screenshots: ${result.successPages}`);
    log(`Failed pages: ${result.errorPages}`);
    
    if (result.errorPages > 0) {
      log('Some pages failed to load. Check the pages.json file for error details.');
    }
    
  } catch (error) {
    log(`Error creating baseline: ${error.message}`);
  }
  
  log('\nReturning to main menu.');
  await mainMenu();
}

async function mainMenu() {
  log('\n=== UI Testing Tools ===');
  log('1. Baseline');
  log('2. Compare');
  log('3. Exit');
  const answer = await ask('\nSelect an option: ');
  if (answer === '1') {
    await baselineMenu();
  } else if (answer === '2') {
    await compareMenu();
  } else if (answer === '3') {
    log('Exiting UI Tester.');
    rl.close();
    process.exit(0);
  } else {
    log('Invalid selection. Exiting.');
    rl.close();
    process.exit(1);
  }
}

async function compareMenu() {
  ensureBaselineDir();
  if (!fs.existsSync(RESULT_DIR)) {
    fs.mkdirSync(RESULT_DIR);
  }
  const folders = getBaselineFolders();
  const categorized = categorizeFolders(folders);
  // Flatten options for selection
  const options = [];
  for (const website in categorized) {
    categorized[website].forEach(date => {
      options.push({ website, date });
    });
  }
  if (options.length === 0) {
    log('No baselines to compare. Returning to main menu.');
    await mainMenu();
    return;
  }
  log('\nSelect a baseline to compare:');
  options.forEach((opt, idx) => {
    log(`  [${idx + 1}] Website: ${opt.website}`);
  });
  const answer = await ask('Enter number: ');
  const idx = parseInt(answer, 10);
  if (isNaN(idx) || idx < 1 || idx > options.length) {
    log('Invalid selection. Returning to main menu.');
    await mainMenu();
    return;
  }
  const selected = options[idx - 1];
  const folderName = `${selected.website}-${selected.date}`;
  const folderPath = path.join(BASELINE_DIR, folderName);
  const pagesPath = path.join(folderPath, 'pages.json');
  if (!fs.existsSync(pagesPath)) {
    log('Baseline pages.json not found. Returning to main menu.');
    await mainMenu();
    return;
  }
  const baselinePages = JSON.parse(fs.readFileSync(pagesPath, 'utf-8'));
  const successPages = baselinePages.filter(p => p.status === 'success');
  log(`\nComparing ${successPages.length} successful pages from baseline...`);
  // Prepare temp folder for new screenshots
  const tempFolder = path.join(folderPath, 'compare_' + Date.now());
  fs.mkdirSync(tempFolder);
  // Prepare for pixelmatch
  const pixelmatch = (await import('pixelmatch')).default;
  const PNG = (await import('pngjs')).PNG;
  
  // Add tracking for all page categories and overall statistics
  let matchCount = 0;
  let changeCount = 0;
  let errorCount = 0;
  const changedPages = [];
  const unchangedPages = [];
  const errorPages = [];
  
  // Add overall difference tracking
  let totalPixelsCompared = 0;
  let totalDiffPixels = 0;
  let successfulComparisons = 0;
  
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  
  let spinner = showSpinner(`Comparing pages (0/${successPages.length})`);
  let processedCount = 0;
  
  for (const p of successPages) {
    try {
      // Update spinner with current progress
      stopSpinner(spinner, `Processing: ${p.url} (${processedCount + 1}/${successPages.length})`);
      spinner = showSpinner(`Comparing pages (${processedCount + 1}/${successPages.length})`);
      
      await page.goto(p.url, { timeout: 100000 });
      const fileName = createSafeFileName(p.url);
      const newScreenshot = path.join(tempFolder, `${fileName}.png`);
      await page.screenshot({ path: newScreenshot, fullPage: true });
      const baselineScreenshot = p.screenshotPath;
      if (fs.existsSync(baselineScreenshot)) {
        // Read both images
        const imgA = PNG.sync.read(fs.readFileSync(baselineScreenshot));
        const imgB = PNG.sync.read(fs.readFileSync(newScreenshot));
        // Prepare diff image
        const { width, height } = imgA;
        const diff = new PNG({ width, height });
        // Compare with threshold
        const diffPixels = pixelmatch(imgA.data, imgB.data, diff.data, width, height, { threshold: PIXEL_DIFF_THRESHOLD });
        const diffPath = path.join(tempFolder, `${fileName}_diff.png`);
        fs.writeFileSync(diffPath, PNG.sync.write(diff));
        const percentDiff = diffPixels / (width * height);
        
        // Add to overall statistics
        totalPixelsCompared += (width * height);
        totalDiffPixels += diffPixels;
        successfulComparisons++;
        
        if (percentDiff < 0.01) { // less than 1% difference is considered a match
          matchCount++;
          unchangedPages.push({ url: p.url, title: p.title, percentDiff: (percentDiff * 100).toFixed(2) });
        } else {
          changeCount++;
          changedPages.push({ url: p.url, diff: diffPath, percentDiff: (percentDiff * 100).toFixed(2) });
        }
      } else {
        errorCount++;
        errorPages.push({ url: p.url, error: 'Baseline screenshot not found' });
      }
    } catch (err) {
      errorCount++;
      errorPages.push({ url: p.url, error: err.message });
      stopSpinner(spinner, `Error processing ${p.url}: ${err.message}`);
      spinner = showSpinner(`Comparing pages (${processedCount + 1}/${successPages.length})`);
    }
    
    processedCount++;
  }
  
  stopSpinner(spinner, `Comparison completed! Processed ${processedCount}/${successPages.length} pages`);
  await browser.close();
  
  // Calculate overall difference percentage
  const overallDiffPercentage = successfulComparisons > 0 
    ? ((totalDiffPixels / totalPixelsCompared) * 100).toFixed(2)
    : '0.00';
  
  // Generate report file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const reportFile = path.join(RESULT_DIR, `compare_${selected.website}_${selected.date}_${timestamp}.txt`);
  let report = '';
  report += '=== Compare Report ===\n';
  report += `Baseline: ${selected.website} (${selected.date})\n`;
  report += `Compared at: ${timestamp}\n`;
  report += `Total pages compared: ${successPages.length}\n`;
  report += `Pages matched: ${matchCount}\n`;
  report += `Pages changed: ${changeCount}\n`;
  report += `Pages with errors: ${errorCount}\n`;
  report += `Overall difference: ${overallDiffPercentage}%\n`;
  
  if (changedPages.length > 0) {
    report += '\nChanged pages:\n';
    changedPages.forEach((c, i) => {
      report += `  [${i + 1}] ${c.url} (diff: ${c.diff}, diff: ${c.percentDiff}%)\n`;
    });
  }
  
  if (unchangedPages.length > 0) {
    report += '\nUnchanged pages:\n';
    unchangedPages.forEach((u, i) => {
      report += `  [${i + 1}] ${u.url} (${u.title || 'No title'}, diff: ${u.percentDiff}%)\n`;
    });
  }
  
  if (errorPages.length > 0) {
    report += '\nPages with errors:\n';
    errorPages.forEach((e, i) => {
      report += `  [${i + 1}] ${e.url} (Error: ${e.error})\n`;
    });
  }
  
  fs.writeFileSync(reportFile, report);
  log(`\n=== Compare Report ===`);
  log(`Report saved to: ${reportFile}`);
  log(`Total pages compared: ${successPages.length}`);
  log(`Pages matched: ${matchCount}`);
  log(`Pages changed: ${changeCount}`);
  log(`Pages with errors: ${errorCount}`);
  log(`Overall difference: ${overallDiffPercentage}%`);
  if (changedPages.length > 0) {
    log('Changed pages:');
    changedPages.forEach((c, i) => log(`  [${i + 1}] ${c.url} (diff: ${c.percentDiff}%)`));
  }
  log('Compare complete. Returning to main menu.');
  await mainMenu();
}

// Main execution entry point
async function main() {
  try {
    await mainMenu();
  } catch (error) {
    log(`Error: ${error.message}`);
    rl.close();
    process.exit(1);
  }
}

// Handle process termination gracefully
process.on('SIGINT', () => {
  log('\nExiting...');
  rl.close();
  process.exit(0);
});

// Start the application
main();