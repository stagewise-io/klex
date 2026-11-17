import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import { DesktopInputDeniedError } from './input-control.js';
import {
  DEFAULT_TREE_DEPTH,
  DEFAULT_TREE_NODES,
  type DesktopScreenshot,
  type DesktopService,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
} from './service.js';

export const DESKTOP_SCREEN_RESOURCE_URI = 'desktop://screen';

const COORDINATES =
  'Coordinates are pixels in the latest desktop_screenshot image (origin top-left).';
const VIEW_HINT = `If your client cannot see images in tool results, open the MCP resource ${DESKTOP_SCREEN_RESOURCE_URI} instead and reopen it to refresh.`;

const coordinate = z.number().int().min(0);
const point = { x: coordinate, y: coordinate };
const button = z.enum(['left', 'middle', 'right']);
const afterAction = {
  screenshot: z
    .boolean()
    .optional()
    .describe('Return a screenshot after the action. Defaults to false.'),
  settleMs: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .optional()
    .describe('Wait before the follow-up screenshot. Defaults to 300.'),
};

type AfterAction = { screenshot?: boolean; settleMs?: number };

const ref = z
  .string()
  .regex(/^r\d+$/)
  .describe('Element ref from desktop_accessibility_tree, such as "r12".');

export interface DesktopToolOptions {
  /** Offer the accessibility tree and clicks by ref. */
  accessibility?: boolean;
}

export function registerDesktopTools(
  server: McpServer,
  desktop: DesktopService,
  principalId: string,
  resolvePath: (path: string) => string = (path) => path,
  options: DesktopToolOptions = {},
): void {
  const action = async (
    input: AfterAction,
    operation: () => Promise<unknown>,
  ) => {
    const text = (value: unknown) => ({
      type: 'text' as const,
      text: JSON.stringify(value ?? { ok: true }),
    });
    try {
      if (!input.screenshot) return { content: [text(await operation())] };
      const { value, screenshot } = await desktop.withSettledScreenshot(
        operation,
        input.settleMs,
      );
      return { content: [text(value), ...imageContent(screenshot)] };
    } catch (error) {
      return errorResult(error);
    }
  };

  server.registerResource(
    'desktop-screen',
    DESKTOP_SCREEN_RESOURCE_URI,
    {
      title: 'Desktop screen',
      description: `Current screenshot of the machine's graphical desktop. ${COORDINATES}`,
      mimeType: 'image/jpeg',
    },
    async (uri) => {
      const shot = await desktop.screenshot('jpeg');
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: shot.mimeType,
            blob: shot.data.toString('base64'),
          },
        ],
      };
    },
  );

  server.registerTool(
    'desktop_screenshot',
    {
      description: `Capture the machine's graphical desktop. Returns an image plus its width and height. ${COORDINATES} ${VIEW_HINT}`,
      inputSchema: z.object({
        format: z.enum(['jpeg', 'png']).optional(),
      }),
    },
    async ({ format }) => {
      try {
        return { content: imageContent(await desktop.screenshot(format)) };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    'desktop_zoom',
    {
      description:
        'Capture a region of the desktop at higher detail, for reading small text. The region uses screenshot coordinates; the returned image is magnified and its pixels are not click coordinates.',
      inputSchema: z.object({
        ...point,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        format: z.enum(['jpeg', 'png']).optional(),
      }),
    },
    async ({ format, ...region }) => {
      try {
        const zoom = await desktop.zoom(region, format);
        return {
          content: [
            {
              type: 'image' as const,
              data: zoom.data.toString('base64'),
              mimeType: zoom.mimeType,
            },
            {
              type: 'text' as const,
              text: JSON.stringify({
                region: zoom.region,
                width: zoom.width,
                height: zoom.height,
              }),
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  const clickOptions = {
    button: button.optional(),
    count: z.number().int().min(1).max(3).optional(),
    modifiers: z.array(z.string().min(1).max(16)).max(4).optional(),
    ...afterAction,
  };
  const clickDescription = `Move the pointer and click. ${COORDINATES} Use count 2 for a double click. Modifiers are held during the click (ctrl, shift, alt, super).`;
  if (options.accessibility) {
    server.registerTool(
      'desktop_click',
      {
        description: `${clickDescription} Pass either x and y, or the ref of an element from desktop_accessibility_tree to click its centre; a ref fails if the element is gone or off screen.`,
        inputSchema: z.object({
          x: coordinate.optional(),
          y: coordinate.optional(),
          ref: ref.optional(),
          ...clickOptions,
        }),
      },
      (input) => {
        const byPoint = input.x !== undefined && input.y !== undefined;
        const anyPoint = input.x !== undefined || input.y !== undefined;
        if (input.ref === undefined ? !byPoint : anyPoint) {
          return errorResult(new Error('Pass either x and y, or ref'));
        }
        const elementRef = input.ref;
        return action(input, () =>
          elementRef === undefined
            ? desktop.click(
                principalId,
                { x: input.x ?? 0, y: input.y ?? 0 },
                input.button ?? 'left',
                input.count ?? 1,
                input.modifiers ?? [],
              )
            : desktop.clickElement(
                principalId,
                elementRef,
                input.button ?? 'left',
                input.count ?? 1,
                input.modifiers ?? [],
              ),
        );
      },
    );
    server.registerTool(
      'desktop_accessibility_tree',
      {
        description: `Read the accessibility tree of the focused window as text, one element per line: ref, role, quoted name, value, bounds as @x,y widthxheight in screenshot coordinates, and states. Pass window (from desktop_list_windows) for another window, or ref to read one subtree. For standard apps it is usually cheaper than a screenshot and gives refs that desktop_click accepts. Refs stay valid while their element exists. Canvas, video, games and some apps expose little or nothing; use desktop_screenshot there and to check visual results. Defaults: interactiveOnly true, maxDepth ${DEFAULT_TREE_DEPTH}, maxNodes ${DEFAULT_TREE_NODES}.`,
        inputSchema: z.object({
          window: z.string().regex(/^\d+$/).optional(),
          ref: ref.optional(),
          interactiveOnly: z
            .boolean()
            .optional()
            .describe(
              'Only controls you can act on. Set false to include labels, headings and text.',
            ),
          maxDepth: z.number().int().min(1).max(MAX_TREE_DEPTH).optional(),
          maxNodes: z.number().int().min(1).max(MAX_TREE_NODES).optional(),
        }),
      },
      async (input) => {
        try {
          const tree = await desktop.accessibilityTree(input);
          return { content: [{ type: 'text' as const, text: tree.text }] };
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  } else {
    server.registerTool(
      'desktop_click',
      {
        description: clickDescription,
        inputSchema: z.object({ ...point, ...clickOptions }),
      },
      (input) =>
        action(input, () =>
          desktop.click(
            principalId,
            { x: input.x, y: input.y },
            input.button ?? 'left',
            input.count ?? 1,
            input.modifiers ?? [],
          ),
        ),
    );
  }
  server.registerTool(
    'desktop_drag',
    {
      description: `Press a mouse button at one point, move to another and release. ${COORDINATES}`,
      inputSchema: z.object({
        from: z.object(point),
        to: z.object(point),
        button: button.optional(),
        ...afterAction,
      }),
    },
    (input) =>
      action(input, () =>
        desktop.drag(principalId, input.from, input.to, input.button ?? 'left'),
      ),
  );
  server.registerTool(
    'desktop_move',
    {
      description: `Move the pointer without clicking, for example to reveal hover menus. ${COORDINATES}`,
      inputSchema: z.object({ ...point, ...afterAction }),
    },
    (input) =>
      action(input, () =>
        desktop.move(principalId, { x: input.x, y: input.y }),
      ),
  );
  server.registerTool(
    'desktop_scroll',
    {
      description: `Scroll with the mouse wheel at a point. Amount is wheel clicks (about 3 lines each). ${COORDINATES}`,
      inputSchema: z.object({
        ...point,
        direction: z.enum(['up', 'down', 'left', 'right']),
        amount: z.number().int().min(1).max(50).optional(),
        ...afterAction,
      }),
    },
    (input) =>
      action(input, () =>
        desktop.scroll(
          principalId,
          { x: input.x, y: input.y },
          input.direction,
          input.amount ?? 3,
        ),
      ),
  );
  server.registerTool(
    'desktop_type',
    {
      description:
        'Type text into the focused window as keyboard input. Click the target field first. Use desktop_key for Enter, Tab and shortcuts.',
      inputSchema: z.object({
        text: z.string().min(1).max(10_000),
        ...afterAction,
      }),
    },
    (input) => action(input, () => desktop.type(principalId, input.text)),
  );
  server.registerTool(
    'desktop_key',
    {
      description:
        'Press keys or shortcuts in order, for example ["ctrl+l"], ["Enter"] or ["ctrl+shift+t"]. Names: letters, digits, Enter, Escape, Tab, Backspace, Delete, Space, Up, Down, Left, Right, Home, End, PageUp, PageDown, F1-F24, and modifiers ctrl, shift, alt, super joined with +.',
      inputSchema: z.object({
        keys: z.array(z.string().min(1).max(64)).min(1).max(32),
        ...afterAction,
      }),
    },
    (input) => action(input, () => desktop.key(principalId, input.keys)),
  );
  server.registerTool(
    'desktop_list_windows',
    {
      description:
        'List visible top-level windows with id, title, bounds in screenshot coordinates and focus.',
      inputSchema: z.object({}),
    },
    () => action({}, () => desktop.listWindows()),
  );
  server.registerTool(
    'desktop_focus_window',
    {
      description: 'Raise and focus a window by id from desktop_list_windows.',
      inputSchema: z.object({
        id: z.string().regex(/^\d+$/),
        ...afterAction,
      }),
    },
    (input) => action(input, () => desktop.focusWindow(principalId, input.id)),
  );
  server.registerTool(
    'desktop_launch',
    {
      description:
        'Start a GUI application on the desktop, detached. Pass the executable and arguments separately; no shell is used. Example: {"command":"google-chrome","args":["https://example.com"]}. settleMs defaults to 2000 here, since applications take longer to appear.',
      inputSchema: z.object({
        command: z.string().min(1).max(4096),
        args: z.array(z.string().max(16_384)).max(64).optional(),
        cwd: z.string().min(1).optional(),
        ...afterAction,
      }),
    },
    (input) =>
      action(
        { screenshot: input.screenshot, settleMs: input.settleMs ?? 2000 },
        () =>
          desktop.launch(
            principalId,
            input.command,
            input.args ?? [],
            resolvePath(input.cwd ?? '.'),
          ),
      ),
  );
}

function imageContent(shot: DesktopScreenshot) {
  return [
    {
      type: 'image' as const,
      data: shot.data.toString('base64'),
      mimeType: shot.mimeType,
    },
    {
      type: 'text' as const,
      text: JSON.stringify({
        width: shot.width,
        height: shot.height,
        screen: shot.screen,
      }),
    },
  ];
}

function errorResult(error: unknown) {
  const text =
    error instanceof DesktopInputDeniedError
      ? JSON.stringify({
          error: {
            code: error.code,
            message: error.message,
            ...(error.holder ? { holder: error.holder } : {}),
          },
        })
      : `Error: ${error instanceof Error ? error.message : String(error)}`;
  return {
    content: [{ type: 'text' as const, text }],
    isError: true as const,
  };
}
