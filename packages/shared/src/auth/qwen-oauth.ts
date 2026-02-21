/**
 * Qwen OAuth Authentication
 *
 * Qwen Code uses OAuth 2.0 Device Authorization Flow (RFC 8628).
 * We implement the flow directly using HTTP requests instead of spawning the CLI.
 *
 * OAuth flow:
 * 1. POST to /api/v1/oauth2/device/code to get device_code and user_code
 * 2. Show user the verification URL and user_code
 * 3. Open browser automatically
 * 4. Poll /api/v1/oauth2/token endpoint until user approves
 * 5. Save tokens to ~/.qwen/oauth_creds.json
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, existsSync, writeFile, mkdirSync } from 'node:fs'
import { promisify } from 'node:util'
import crypto from 'node:crypto'

const readFileAsync = promisify(readFile)
const writeFileAsync = promisify(writeFile)

// OAuth Endpoints
const QWEN_OAUTH_BASE_URL = 'https://chat.qwen.ai'
const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`
const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56'
const QWEN_OAUTH_SCOPE = 'openid profile email model.completion'

export interface QwenTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  tokenType?: string
}

interface DeviceAuthorizationResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval?: number
}

interface DeviceTokenResponse {
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  error?: string
  error_description?: string
}

/**
 * Get the path to Qwen's OAuth credentials file
 */
function getQwenOAuthCredsPath(): string {
  return join(homedir(), '.qwen', 'oauth_creds.json')
}

/**
 * Read Qwen's OAuth credentials file and extract tokens
 */
async function readQwenTokens(): Promise<QwenTokens | null> {
  // Read oauth_creds.json - this is where Qwen stores OAuth tokens
  const configPath = getQwenOAuthCredsPath()

  if (!existsSync(configPath)) {
    return null
  }

  try {
    const configContent = await readFileAsync(configPath, 'utf-8')
    const config = JSON.parse(configContent)

    // Qwen OAuth credentials structure (per qwen-code/packages/core/src/qwen/qwenOAuth2.ts):
    // {
    //   "access_token": "...",
    //   "token_type": "Bearer",
    //   "refresh_token": "...",
    //   "resource_url": "chat.qwen.ai",
    //   "expiry_date": 1771612236773
    // }

    if (!config.access_token) {
      console.warn('[Qwen OAuth] No access_token found in credentials file')
      return null
    }

    const tokens: QwenTokens = {
      accessToken: config.access_token,
      tokenType: config.token_type || 'Bearer',
    }

    if (config.refresh_token) {
      tokens.refreshToken = config.refresh_token
    }

    if (config.expiry_date) {
      tokens.expiresAt = config.expiry_date
    }

    console.log('[Qwen OAuth] Successfully read tokens, expiresAt:', config.expiry_date ? new Date(config.expiry_date).toISOString() : 'unknown')
    return tokens
  } catch (error) {
    console.error('[Qwen OAuth] Failed to read tokens:', error)
    return null
  }
}

/**
 * Start Qwen OAuth flow
 *
 * Qwen uses Device Authorization Flow (RFC 8628):
 * 1. Spawn `qwen auth` command to trigger OAuth
 * 2. CLI displays device_code and user_code
 * 3. User visits the URL in browser and enters the code
 * 4. CLI polls for authorization completion
 * 5. Tokens are saved to ~/.qwen/oauth_creds.json
 */
export async function startQwenOAuth(
  onStatus?: (message: string) => void
): Promise<void> {
  onStatus?.('Starting Qwen CLI authentication...')

  return new Promise((resolve, reject) => {
    // Start qwen auth command - this triggers the OAuth device flow
    const qwenProcess = spawn('qwen', ['auth'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    })

    let authCompleted = false
    let authorizationUrl: string | null = null
    let userCode: string | null = null
    let browserOpened = false

    // Parse output for authorization URL and user code
    qwenProcess.stdout?.on('data', (data) => {
      const output = data.toString()
      console.log('[Qwen OAuth] CLI output:', output.substring(0, 500))

      // Look for the authorization URL pattern
      const urlMatch = output.match(/https:\/\/[^\s]*authorize[^\s]*/i)
      if (urlMatch && !authorizationUrl) {
        authorizationUrl = urlMatch[0]
        console.log('[Qwen OAuth] Found authorization URL:', authorizationUrl)
      }

      // Look for user code
      const codeMatch = output.match(/user_code[=:\s]*([A-Z0-9]+)/i)
      if (codeMatch && !userCode) {
        userCode = codeMatch[1]
        console.log('[Qwen OAuth] Found user code:', userCode)
      }

      // Look for success indicators
      if (output.toLowerCase().includes('success') || 
          output.toLowerCase().includes('authenticated') ||
          output.includes('I\'m ready')) {
        authCompleted = true
        onStatus?.('Authorization completed!')
        console.log('[Qwen OAuth] Auth completed detected from output')
        resolve()
      }
    })

    qwenProcess.stderr?.on('data', (data) => {
      const error = data.toString()
      console.error('[Qwen OAuth] CLI stderr:', error)
    })

    qwenProcess.on('error', (error) => {
      if (error.message.includes('ENOENT')) {
        reject(new Error('Qwen CLI not found. Please install it with: npm install -g @qwen-code/qwen-code'))
      } else {
        reject(new Error(`Failed to start Qwen CLI: ${error.message}`))
      }
    })

    qwenProcess.on('exit', async (code, signal) => {
      console.log('[Qwen OAuth] Process exited with code:', code, 'signal:', signal)
      
      if (authCompleted) {
        console.log('[Qwen OAuth] Auth was already completed, resolving')
        resolve()
        return
      }

      // After exit, check if tokens were saved
      // Wait a bit to ensure file is written
      await new Promise(resolve => setTimeout(resolve, 500))
      
      const tokens = await readQwenTokens()
      if (tokens) {
        console.log('[Qwen OAuth] Tokens found after exit, resolving')
        authCompleted = true
        onStatus?.('Authentication completed!')
        resolve()
        return
      }
      
      if (signal === 'SIGINT') {
        console.log('[Qwen OAuth] Process was interrupted')
        reject(new Error('Authentication cancelled'))
        return
      }
      
      // CLI exited normally (code 0) but no tokens found
      // This might mean user closed browser without completing auth
      if (code === 0) {
        console.log('[Qwen OAuth] CLI exited normally but no tokens found')
        // Check one more time after a delay
        await new Promise(resolve => setTimeout(resolve, 1000))
        const retryTokens = await readQwenTokens()
        if (retryTokens) {
          console.log('[Qwen OAuth] Tokens found on retry, resolving')
          onStatus?.('Authentication completed!')
          resolve()
          return
        }
        reject(new Error('Authentication was not completed. Please try again.'))
        return
      }
      
      console.log('[Qwen OAuth] Process exited with error code:', code)
      reject(new Error(`Qwen CLI exited with code ${code}`))
    })

    // Open the authorization URL in browser when we have it
    const openBrowserWhenReady = setInterval(() => {
      if (authorizationUrl && !browserOpened) {
        browserOpened = true
        clearInterval(openBrowserWhenReady)
        
        console.log('[Qwen OAuth] Opening browser:', authorizationUrl)
        
        // Try to open browser automatically
        const urlToOpen = authorizationUrl
        if (urlToOpen) {
          import('node:child_process').then(({ spawn: spawnNode }) => {
            if (process.platform === 'darwin') {
              spawnNode('open', [urlToOpen])
            } else if (process.platform === 'win32') {
              spawnNode('cmd', ['/c', 'start', urlToOpen])
            } else {
              spawnNode('xdg-open', [urlToOpen])
            }
          }).catch((err) => {
            console.error('[Qwen OAuth] Failed to open browser:', err)
          })
        }
      }
    }, 500)

    // Also periodically check for tokens (in case auth completes but CLI doesn't exit)
    const checkTokensInterval = setInterval(async () => {
      const tokens = await readQwenTokens()
      if (tokens && !authCompleted) {
        authCompleted = true
        clearInterval(checkTokensInterval)
        clearInterval(openBrowserWhenReady)
        qwenProcess.kill('SIGTERM')
        onStatus?.('Authentication completed!')
        console.log('[Qwen OAuth] Tokens detected via polling, resolving')
        resolve()
      }
    }, 2000)

    // Timeout after 5 minutes
    setTimeout(() => {
      if (!authCompleted) {
        qwenProcess.kill('SIGTERM')
        clearInterval(openBrowserWhenReady)
        clearInterval(checkTokensInterval)
        reject(new Error('Authentication timeout. Please try again.'))
      }
    }, 300000)
  })
}

/**
 * Get Qwen OAuth tokens after authentication
 */
export async function getQwenOAuthTokens(): Promise<QwenTokens | null> {
  return await readQwenTokens()
}

/**
 * Check if Qwen CLI is installed
 */
export async function isQwenCliInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const check = spawn('qwen', ['--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: true,
    })
    check.on('error', () => resolve(false))
    check.on('exit', (code) => resolve(code === 0))
  })
}
