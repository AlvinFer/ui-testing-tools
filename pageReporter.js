const { chromium } = require('@playwright/test');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Helper function to categorize pages
function categorizePage(url, hostname) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    
    // Remove trailing slash and split path
    const pathSegments = pathname.replace(/\/$/, '').split('/').filter(segment => segment.length > 0);
    
    // Main pages: homepage or pages with 1 segment in path
    if (pathSegments.length <= 1) {
      return 'main';
    }
    
    // Sub pages: pages with 2 or more segments in path
    return 'sub';
  } catch {
    return 'main'; // Default to main if URL parsing fails
  }
}

// Simple loading indicator
let loadingFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let currentFrame = 0;

function showLoadingIndicator(processed, currentUrl) {
  const frame = loadingFrames[currentFrame % loadingFrames.length];
  const shortUrl = currentUrl.length > 50 ? currentUrl.substring(0, 47) + '...' : currentUrl;
  process.stdout.write(`\r${frame} Crawling... (${processed} pages) ${shortUrl}`);
  currentFrame++;
}

function clearLoadingIndicator() {
  process.stdout.write('\r' + ' '.repeat(100) + '\r');
}

// Function to create safe filename from URL
function createSafeFileName(url) {
  try {
    const urlObj = new URL(url);
    let fileName = urlObj.hostname + urlObj.pathname;
    // Replace unsafe characters with underscores
    fileName = fileName.replace(/[^a-zA-Z0-9]/g, '_');
    // Remove consecutive underscores and trim
    fileName = fileName.replace(/_+/g, '_').replace(/^_|_$/g, '');
    // Limit length
    if (fileName.length > 100) {
      fileName = fileName.substring(0, 100);
    }
    return fileName || 'homepage';
  } catch {
    return 'invalid_url';
  }
}

// Function to create screenshot folder
function createScreenshotFolder(hostname) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + 
                   new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
  const cleanHostname = hostname.replace(/[^a-zA-Z0-9]/g, '_');
  const folderName = `screenshots_${cleanHostname}_${timestamp}`;
  
  try {
    if (!fs.existsSync(folderName)) {
      fs.mkdirSync(folderName, { recursive: true });
    }
    return folderName;
  } catch (error) {
    console.error(`Failed to create screenshot folder: ${error.message}`);
    return null;
  }
}

async function generatePageReport(startUrl, showProgress = false, takeScreenshots = false) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Set viewport for consistent screenshots
  await page.setViewportSize({ width: 1920, height: 1080 });
  
  const visited = new Set();
  const toVisit = [startUrl];
  const hostname = new URL(startUrl).hostname;
  
  const mainPages = new Set();
  const subPages = new Set();
  const errorPages = new Set();
  const pageDetails = [];
  
  // Create screenshot folder if needed
  let screenshotFolder = null;
  if (takeScreenshots) {
    screenshotFolder = createScreenshotFolder(hostname);
    if (!screenshotFolder) {
      console.log('⚠️  Screenshot folder creation failed. Continuing without screenshots.');
      takeScreenshots = false;
    }
  }

  if (!showProgress) {
    console.log(`\n🔍 Starting crawl for: ${startUrl}`);
    console.log(`📊 Hostname: ${hostname}\n`);
  }

  let processedCount = 0;

  while (toVisit.length > 0) {
    const currentUrl = toVisit.shift();
    if (!visited.has(currentUrl)) {
      visited.add(currentUrl);
      
      // Categorize the current page
      const pageType = categorizePage(currentUrl, hostname);
      const urlObj = new URL(currentUrl);
      const pathSegments = urlObj.pathname.replace(/\/$/, '').split('/').filter(segment => segment.length > 0);
      
      if (pageType === 'main') {
        mainPages.add(currentUrl);
      } else {
        subPages.add(currentUrl);
      }
      
      pageDetails.push({
        url: currentUrl,
        type: pageType,
        pathDepth: pathSegments.length,
        path: urlObj.pathname,
        status: 'pending', // Will be updated after page load
        title: null,
        canonical: null
      });

      if (!showProgress) {
        console.log(`📍 Visiting: ${currentUrl} (${pageType.toUpperCase()})`);
      }

      try {
        await page.goto(currentUrl, { timeout: 10000000 });
        
        // Extract page title and canonical URL
        const pageInfo = await page.evaluate(() => {
          const title = document.title || 'No title';
          const canonicalElement = document.querySelector('link[rel="canonical"]');
          const canonicalUrl = canonicalElement ? canonicalElement.href : null;
          const links = Array.from(document.links).map(link => link.href);
          
          return {
            title: title.trim(),
            canonical: canonicalUrl,
            links: links
          };
        });
        
        const links = pageInfo.links;
        
        // Update page details with extracted information
        pageDetails[pageDetails.length - 1].status = 'success';
        pageDetails[pageDetails.length - 1].title = pageInfo.title;
        pageDetails[pageDetails.length - 1].canonical = pageInfo.canonical;
        
        // Take screenshot if enabled
        if (takeScreenshots && screenshotFolder) {
          try {
            const fileName = createSafeFileName(currentUrl);
            const screenshotPath = path.join(screenshotFolder, `${fileName}.png`);
            await page.screenshot({ 
              path: screenshotPath, 
              fullPage: true,
              type: 'png'
            });
            pageDetails[pageDetails.length - 1].screenshotPath = screenshotPath;
          } catch (screenshotError) {
            if (!showProgress) {
              console.log(`📸 Failed to capture screenshot for ${currentUrl}: ${screenshotError.message}`);
            }
          }
        }

        const internalLinks = links.filter(link => {
          try {
            return new URL(link).hostname === hostname;
          } catch {
            return false;
          }
        });

        // Filter out URLs ending with # symbol to avoid duplicates
        const filteredLinks = internalLinks.filter(link => !link.endsWith('#'));
        const newLinks = filteredLinks.filter(link => !visited.has(link));
        toVisit.push(...newLinks);
      } catch (error) {
        // Mark as error page
        errorPages.add(currentUrl);
        pageDetails[pageDetails.length - 1].status = 'error';
        pageDetails[pageDetails.length - 1].errorMessage = error.message;
        
        if (!showProgress) {
          console.error(`❌ Failed to load: ${currentUrl}`);
          if (error.name === 'TimeoutError') {
            console.error(`⏰ Timeout error: Page took too long to load`);
          } else {
            console.error(`💥 Error: ${error.message}`);
          }
        }
      }
      
      processedCount++;
      // Show loading indicator
      if (showProgress) {
        showLoadingIndicator(processedCount, currentUrl);
      }
    }
  }

  if (showProgress) {
    clearLoadingIndicator();
    console.log('\n');
  }

  await browser.close();
  
  return {
    totalPages: visited.size,
    mainPages: mainPages.size,
    subPages: subPages.size,
    errorPages: errorPages.size,
    successfulPages: visited.size - errorPages.size,
    pageDetails: pageDetails,
    hostname: hostname,
    startUrl: startUrl,
    screenshotFolder: screenshotFolder,
    screenshotsTaken: takeScreenshots
  };
}

function generateReport(reportData, outputType = 'terminal') {
  const { totalPages, mainPages, subPages, errorPages, successfulPages, pageDetails, hostname, startUrl, screenshotFolder, screenshotsTaken } = reportData;
  
  let reportContent = '';
  
  // Header
  reportContent += '='.repeat(80) + '\n';
  reportContent += '📋 WEBSITE CRAWL REPORT\n';
  reportContent += '='.repeat(80) + '\n';
  
  reportContent += `\n🌐 Target URL: ${startUrl}\n`;
  reportContent += `🏠 Hostname: ${hostname}\n`;
  reportContent += `📅 Generated: ${new Date().toLocaleString()}\n`;
  if (screenshotsTaken && screenshotFolder) {
    reportContent += `📸 Screenshots: Available in ${screenshotFolder}/\n`;
  }
  
  // Summary Statistics
  reportContent += '\n' + '-'.repeat(50) + '\n';
  reportContent += '📊 SUMMARY STATISTICS\n';
  reportContent += '-'.repeat(50) + '\n';
  
  reportContent += `📄 Total Pages Found: ${totalPages}\n`;
  reportContent += `✅ Successful Pages: ${successfulPages}\n`;
  reportContent += `❌ Error Pages: ${errorPages}\n`;
  reportContent += `🏢 Main Pages: ${mainPages}\n`;
  reportContent += `📂 Sub Pages: ${subPages}\n`;
  
  const mainPagePercentage = totalPages > 0 ? ((mainPages / totalPages) * 100).toFixed(1) : 0;
  const subPagePercentage = totalPages > 0 ? ((subPages / totalPages) * 100).toFixed(1) : 0;
  const errorPercentage = totalPages > 0 ? ((errorPages / totalPages) * 100).toFixed(1) : 0;
  
  reportContent += `📈 Main Pages: ${mainPagePercentage}% of total\n`;
  reportContent += `📉 Sub Pages: ${subPagePercentage}% of total\n`;
  reportContent += `⚠️  Error Pages: ${errorPercentage}% of total\n`;
  
  // Main Pages Details
  reportContent += '\n' + '-'.repeat(50) + '\n';
  reportContent += '🏢 MAIN PAGES DETAILS\n';
  reportContent += '-'.repeat(50) + '\n';
  
  const mainPageDetails = pageDetails.filter(page => page.type === 'main');
  mainPageDetails.forEach((page, index) => {
    const statusIcon = page.status === 'success' ? '✅' : '❌';
    reportContent += `${index + 1}. ${statusIcon} ${page.url}\n`;
    if (page.status === 'success') {
      reportContent += `   📝 Title: ${page.title || 'No title'}\n`;
      if (page.canonical && page.canonical !== page.url) {
        reportContent += `   🔗 Canonical: ${page.canonical}\n`;
      }
      if (page.screenshotPath) {
        reportContent += `   📸 Screenshot: ${page.screenshotPath}\n`;
      }
    }
  });
  
  // Sub Pages Details
  reportContent += '\n' + '-'.repeat(50) + '\n';
  reportContent += '📂 SUB PAGES DETAILS\n';
  reportContent += '-'.repeat(50) + '\n';
  
  const subPageDetails = pageDetails.filter(page => page.type === 'sub');
  subPageDetails.forEach((page, index) => {
    const statusIcon = page.status === 'success' ? '✅' : '❌';
    reportContent += `${index + 1}. ${statusIcon} ${page.url} (Depth: ${page.pathDepth})\n`;
    if (page.status === 'success') {
      reportContent += `   📝 Title: ${page.title || 'No title'}\n`;
      if (page.canonical && page.canonical !== page.url) {
        reportContent += `   🔗 Canonical: ${page.canonical}\n`;
      }
      if (page.screenshotPath) {
        reportContent += `   📸 Screenshot: ${page.screenshotPath}\n`;
      }
    }
  });
  
  // Error Pages Details
  if (errorPages > 0) {
    reportContent += '\n' + '-'.repeat(50) + '\n';
    reportContent += '❌ ERROR PAGES DETAILS\n';
    reportContent += '-'.repeat(50) + '\n';
    
    const errorPageDetails = pageDetails.filter(page => page.status === 'error');
    errorPageDetails.forEach((page, index) => {
      reportContent += `${index + 1}. ${page.url}\n`;
      reportContent += `   Error: ${page.errorMessage}\n`;
    });
  }
  
  // Path Depth Analysis
  reportContent += '\n' + '-'.repeat(50) + '\n';
  reportContent += '📈 PATH DEPTH ANALYSIS\n';
  reportContent += '-'.repeat(50) + '\n';
  
  const depthStats = {};
  pageDetails.forEach(page => {
    depthStats[page.pathDepth] = (depthStats[page.pathDepth] || 0) + 1;
  });
  
  Object.keys(depthStats).sort((a, b) => parseInt(a) - parseInt(b)).forEach(depth => {
    reportContent += `Depth ${depth}: ${depthStats[depth]} pages\n`;
  });
  
  // Canonical URL Analysis
  reportContent += '\n' + '-'.repeat(50) + '\n';
  reportContent += '🔗 CANONICAL URL ANALYSIS\n';
  reportContent += '-'.repeat(50) + '\n';
  
  const allSuccessfulPages = pageDetails.filter(page => page.status === 'success');
  const pagesWithCanonical = allSuccessfulPages.filter(page => page.canonical);
  const pagesWithDifferentCanonical = allSuccessfulPages.filter(page => 
    page.canonical && page.canonical !== page.url
  );
  const pagesWithoutCanonical = allSuccessfulPages.filter(page => !page.canonical);
  
  reportContent += `📊 Pages with canonical tags: ${pagesWithCanonical.length}/${allSuccessfulPages.length}\n`;
  reportContent += `🔄 Pages with different canonical URL: ${pagesWithDifferentCanonical.length}\n`;
  reportContent += `⚠️  Pages without canonical tags: ${pagesWithoutCanonical.length}\n`;
  
  if (pagesWithDifferentCanonical.length > 0) {
    reportContent += '\n📋 Pages with different canonical URLs:\n';
    pagesWithDifferentCanonical.forEach((page, index) => {
      reportContent += `${index + 1}. ${page.url}\n`;
      reportContent += `   → ${page.canonical}\n`;
    });
  }
  
  if (pagesWithoutCanonical.length > 0) {
    reportContent += '\n⚠️  Pages missing canonical tags:\n';
    pagesWithoutCanonical.slice(0, 10).forEach((page, index) => {
      reportContent += `${index + 1}. ${page.url}\n`;
    });
    if (pagesWithoutCanonical.length > 10) {
      reportContent += `... and ${pagesWithoutCanonical.length - 10} more pages\n`;
    }
  }
  
  // Footer
  reportContent += '\n' + '='.repeat(80) + '\n';
  reportContent += '✅ REPORT COMPLETE\n';
  reportContent += '='.repeat(80) + '\n';
  
  if (outputType === 'terminal') {
    console.log(reportContent);
  }
  
  return reportContent;
}

function generateFileName(hostname) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + 
                   new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
  const cleanHostname = hostname.replace(/[^a-zA-Z0-9]/g, '_');
  return `report_${cleanHostname}_${timestamp}.txt`;
}

async function askForUrl() {
  return new Promise((resolve) => {
    rl.question('🌐 Enter the URL to crawl (e.g., https://example.com): ', (url) => {
      resolve(url.trim());
    });
  });
}

async function askForOutputType() {
  return new Promise((resolve) => {
    console.log('\n📤 Choose output format:');
    console.log('1. Display in terminal');
    console.log('2. Generate file');
    rl.question('Enter your choice (1 or 2): ', (choice) => {
      resolve(choice.trim());
    });
  });
}

async function askForScreenshots() {
  return new Promise((resolve) => {
    console.log('\n📸 Take screenshots of all pages?');
    console.log('Note: This will significantly increase crawling time but provides visual documentation.');
    rl.question('Take screenshots? (y/n): ', (choice) => {
      resolve(choice.toLowerCase().startsWith('y'));
    });
  });
}

async function askToContinue() {
  return new Promise((resolve) => {
    rl.question('\n🔄 Would you like to crawl another URL? (y/n): ', (answer) => {
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

async function main() {
  console.log('🚀 Website Page Reporter');
  console.log('========================\n');
  console.log('This tool will crawl a website and generate a detailed report');
  console.log('categorizing pages into main pages and sub pages.\n');
  
  let continueCrawling = true;
  
  while (continueCrawling) {
    try {
      const url = await askForUrl();
      
      if (!url) {
        console.log('❌ Please enter a valid URL.\n');
        continue;
      }
      
      // Validate URL format
      try {
        new URL(url);
      } catch {
        console.log('❌ Invalid URL format. Please include http:// or https://\n');
        continue;
      }
      
      const outputType = await askForOutputType();
      const takeScreenshots = await askForScreenshots();
      const showProgress = outputType === '2';
      
      if (showProgress) {
        console.log('\n⏳ Starting crawl with loading indicator... This may take a while depending on the website size.\n');
      } else {
        console.log('\n⏳ Starting crawl... This may take a while depending on the website size.\n');
      }
      
      const reportData = await generatePageReport(url, showProgress, takeScreenshots);
      
      if (outputType === '1') {
        // Terminal output
        generateReport(reportData, 'terminal');
      } else if (outputType === '2') {
        // File output
        const reportContent = generateReport(reportData, 'file');
        const fileName = generateFileName(reportData.hostname);
        
        try {
          fs.writeFileSync(fileName, reportContent);
          console.log(`\n📄 Report saved to: ${fileName}`);
          if (reportData.screenshotsTaken && reportData.screenshotFolder) {
            console.log(`📸 Screenshots saved to: ${reportData.screenshotFolder}/`);
          }
          console.log(`📊 Summary: ${reportData.totalPages} total pages, ${reportData.mainPages} main pages, ${reportData.subPages} sub pages, ${reportData.errorPages} error pages`);
        } catch (error) {
          console.error(`❌ Failed to save report: ${error.message}`);
        }
      }
      
      continueCrawling = await askToContinue();
      
    } catch (error) {
      console.error('💥 An unexpected error occurred:', error.message);
      continueCrawling = await askToContinue();
    }
  }
  
  console.log('👋 Thank you for using Website Page Reporter!');
  rl.close();
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Goodbye!');
  rl.close();
  process.exit(0);
});

main().catch(console.error); 