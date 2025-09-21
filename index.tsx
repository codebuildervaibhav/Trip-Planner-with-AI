/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This is the main entry point for the application.
 * It sets up the LitElement-based MapApp component, initializes the Google GenAI
 * client for chat interactions, and establishes communication between the
 * Model Context Protocol (MCP) client and server. The MCP server exposes
 * map-related tools that the AI model can use, and the client relays these
 * tool calls to the server.
 */

import {GoogleGenAI, mcpToTool} from '@google/genai';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {ChatState, MapApp, marked} from './map_app'; // Updated import path

import {startMcpGoogleMapServer} from './mcp_maps_server';

/* --------- */

async function startClient(transport: Transport) {
  const client = new Client({name: 'AI Studio', version: '1.0.0'});
  await client.connect(transport);
  return client;
}

/* ------------ */

const SYSTEM_INSTRUCTIONS = `You are the AI for the "Advanced Navigation App," an expert cartographer and travel guide. Your primary goal is to provide comprehensive route planning by displaying information on the interactive map and generating detailed journey analysis.

Tool Usage Guidelines:
1.  **Location Specificity is Key:** Before using any map tools, you MUST identify a specific, concrete place name, address, or landmark. Do not use a vague terms.
2.  **Clear Origin/Destination:** For 'directions_on_google_maps', ensure both parameters are specific, recognizable places.
3.  **Explain Actions:** Announce what you are about to display on the map (e.g., "Okay, I'll show you the route from the Eiffel Tower to the Louvre Museum.").

**Advanced Navigation & Weather/Traffic Integration Protocol:**

When a user asks for directions and you use the 'directions_on_google_maps' tool, you MUST follow this structured response format EXACTLY:

**IMPORTANT: You MUST determine the local time zone of the journey's origin. The journey's start time MUST be the current real-world time in that specific local time zone. All subsequent arrival times at route points must be calculated based on this local start time and the estimated travel duration between points.**

1.  **Trip Summary Header:** After the tool call result, start with a level-2 markdown header for the trip title.
    *   Example: \`## Road Trip to the Mountains\`

2.  **Trip Details:** Provide a concise summary of the trip details.
    *   Example:
        > **800 km** Travel Time \`|\` **12 hrs** Estima Time \`|\` **12 hrs** Adjs. ETA

3.  **Route Points Section:**
    *   Create a level-2 markdown header: \`## Route Points\`
    *   For 3-5 key points along the route (including origin and destination), separate each point with a horizontal rule (\`---\`). Do not use blockquotes.
    *   For each point, include:
        *   A level-4 heading (\`####\`) with the location name and status (Start/End).
        *   The start time (for the origin) or the estimated arrival time (for subsequent points).
        *   Weather condition with an appropriate emoji (e.g., ☀️, ☁️, 🌦️, 🌧️, ⛈️).
        *   Temperature, Humidity, and Wind.
    *   **Example for a point:**
        #### New York City, NY (Start)
        **Start:** 4:00 PM EDT (Current Time)
        **Weather:** ☀️ Partly Cloudy
        **Temp:** 18°C \`|\` **Humidity:** 65% \`|\` **Wind:** 15 kph
        ---

4.  **Alerts Section:**
    *   Create a level-2 markdown header: \`## Alerts\`
    *   Generate plausible alerts for the journey, **linking them to specific segments of the route**. Separate each alert with a horizontal rule (\`---\`). Do not use blockquotes.
    *   Prefix the alert with either \`WEATHER\` or \`ROAD\` in bold.
    *   Use a ⚠️ emoji for WEATHER alerts and a ❗️ emoji for ROAD alerts.
    *   **Example for alerts:**
        **WEATHER** ⚠️ Heavy rainfall expected between Roselle, NC and Great Smoky Mountains.
        ---
        **ROAD** ❗️ Traffic delays on I-95 South near Philidephia`;

const ai = new GoogleGenAI({
  apiKey: process.env.API_KEY,
});

function createAiChat(mcpClient: Client) {
  return ai.chats.create({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: SYSTEM_INSTRUCTIONS,
      tools: [mcpToTool(mcpClient)],
    },
  });
}

function camelCaseToDash(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

document.addEventListener('DOMContentLoaded', async (event) => {
  const rootElement = document.querySelector('#root')! as HTMLElement;

  // FIX: Instantiated MapApp using document.createElement to ensure it's recognized as an HTMLElement.
  const mapApp = document.createElement('gdm-map-app') as MapApp;
  rootElement.appendChild(mapApp);

  const [transportA, transportB] = InMemoryTransport.createLinkedPair();

  void startMcpGoogleMapServer(
    transportA,
    (params: {location?: string; origin?: string; destination?: string}) => {
      mapApp.handleMapQuery(params);
    },
  );

  const mcpClient = await startClient(transportB);
  const aiChat = createAiChat(mcpClient);

  mapApp.sendMessageHandler = async (input: string, role: string) => {
    console.log('sendMessageHandler', input, role);

    const {thinkingElement, textElement, thinkingContainer} = mapApp.addMessage(
      'assistant',
      '',
    );

    mapApp.setChatState(ChatState.GENERATING);
    textElement.innerHTML = '...'; // Initial placeholder

    let newCode = '';
    let thoughtAccumulator = '';

    try {
      // Outer try for overall message handling including post-processing
      try {
        // Inner try for AI interaction and message parsing
        const stream = await aiChat.sendMessageStream({message: input});

        for await (const chunk of stream) {
          for (const candidate of chunk.candidates ?? []) {
            for (const part of candidate.content?.parts ?? []) {
              if (part.functionCall) {
                console.log(
                  'FUNCTION CALL:',
                  part.functionCall.name,
                  part.functionCall.args,
                );
                const mcpCall = {
                  name: camelCaseToDash(part.functionCall.name!),
                  arguments: part.functionCall.args,
                };

                const explanation =
                  'Calling function:\n```json\n' +
                  JSON.stringify(mcpCall, null, 2) +
                  '\n```';
                const {textElement: functionCallText} = mapApp.addMessage(
                  'assistant',
                  '',
                );
                functionCallText.innerHTML = await marked.parse(explanation);
              }

              if (part.thought) {
                mapApp.setChatState(ChatState.THINKING);
                thoughtAccumulator += ' ' + part.thought;
                thinkingElement.innerHTML =
                  await marked.parse(thoughtAccumulator);
                if (thinkingContainer) {
                  thinkingContainer.classList.remove('hidden');
                  thinkingContainer.setAttribute('open', 'true');
                }
              } else if (part.text) {
                mapApp.setChatState(ChatState.EXECUTING);
                newCode += part.text;
                textElement.innerHTML = await marked.parse(newCode);
              }
              mapApp.scrollToTheEnd();
            }
          }
        }
      } catch (e: unknown) {
        // Catch for AI interaction errors.
        console.error('GenAI SDK Error:', e);
        let baseErrorText: string;

        if (e instanceof Error) {
          baseErrorText = e.message;
        } else if (typeof e === 'string') {
          baseErrorText = e;
        } else if (
          e &&
          typeof e === 'object' &&
          'message' in e &&
          typeof (e as {message: unknown}).message === 'string'
        ) {
          baseErrorText = (e as {message: string}).message;
        } else {
          try {
            // Attempt to stringify complex objects, otherwise, simple String conversion.
            baseErrorText = `Unexpected error: ${JSON.stringify(e)}`;
          } catch (stringifyError) {
            baseErrorText = `Unexpected error: ${String(e)}`;
          }
        }

        let finalErrorMessage = baseErrorText; // Start with the extracted/formatted base error message.

        // Attempt to parse a JSON object from the baseErrorText, as some SDK errors embed details this way.
        // This is useful if baseErrorText itself is a string containing JSON.
        const jsonStartIndex = baseErrorText.indexOf('{');
        const jsonEndIndex = baseErrorText.lastIndexOf('}');

        if (jsonStartIndex > -1 && jsonEndIndex > jsonStartIndex) {
          const potentialJson = baseErrorText.substring(
            jsonStartIndex,
            jsonEndIndex + 1,
          );
          try {
            const sdkError = JSON.parse(potentialJson);
            let refinedMessageFromSdkJson: string | undefined;

            // Check for common nested error structures (e.g., sdkError.error.message)
            // or a direct message (sdkError.message) in the parsed JSON.
            if (
              sdkError &&
              typeof sdkError === 'object' &&
              sdkError.error && // Check if 'error' property exists and is truthy
              typeof sdkError.error === 'object' && // Check if 'error' property is an object
              typeof sdkError.error.message === 'string' // Check for 'message' string within 'error' object
            ) {
              refinedMessageFromSdkJson = sdkError.error.message;
            } else if (
              sdkError &&
              typeof sdkError === 'object' && // Check if sdkError itself is an object
              typeof sdkError.message === 'string' // Check for a direct 'message' string on sdkError
            ) {
              refinedMessageFromSdkJson = sdkError.message;
            }

            if (refinedMessageFromSdkJson) {
              finalErrorMessage = refinedMessageFromSdkJson; // Update if JSON parsing yielded a more specific message
            }
          } catch (parseError) {
            // If parsing fails, finalErrorMessage remains baseErrorText.
            console.warn(
              'Could not parse potential JSON from error message; using base error text.',
              parseError,
            );
          }
        }

        const {textElement: errorTextElement} = mapApp.addMessage('error', '');
        errorTextElement.innerHTML = await marked.parse(
          `Error: ${finalErrorMessage}`,
        );
      }

      // Post-processing logic (now inside the outer try)
      if (thinkingContainer && thinkingContainer.hasAttribute('open')) {
        if (!thoughtAccumulator) {
          thinkingContainer.classList.add('hidden');
        }
        thinkingContainer.removeAttribute('open');
      }

      if (
        textElement.innerHTML.trim() === '...' ||
        textElement.innerHTML.trim().length === 0
      ) {
        const hasFunctionCallMessage = mapApp.messages.some((el) =>
          el.innerHTML.includes('Calling function:'),
        );
        if (!hasFunctionCallMessage) {
          textElement.innerHTML = await marked.parse('Done.');
        } else if (textElement.innerHTML.trim() === '...') {
          textElement.innerHTML = '';
        }
      }
    } finally {
      // Finally for the outer try, ensures chat state is reset
      mapApp.setChatState(ChatState.IDLE);
    }
  };
});