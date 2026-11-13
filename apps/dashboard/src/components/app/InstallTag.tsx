import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { scriptAttr } from "@snagset/types/names";

/** The one tag there is: the stub, the site, nothing else. */
export function installTag(uid: string): string {
  return `<script src="${location.origin}/snag.js" ${scriptAttr("site")}="${uid}" defer></script>`;
}

/** A block of code with a copy button; `label` names what is copied. */
function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative rounded-md border border-border bg-background px-3 py-2.5 pr-11 font-mono text-[12.5px] leading-relaxed">
      <code className="whitespace-pre-wrap break-all">{code}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute right-1.5 top-1.5"
        aria-label={copied ? "Copied" : label}
        onClick={() => {
          void navigator.clipboard?.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

export function InstallTag({ uid }: { uid: string }) {
  return <CodeBlock code={installTag(uid)} label="Copy the tag" />;
}

const NPM = "npm install snagset";

function Note({ children }: { children: React.ReactNode }) {
  return <p className="m-0 text-[12.5px] text-muted-foreground">{children}</p>;
}

/**
 * The same widget, put on a page the way that page is built: the tag, or the
 * `snagset` package's component for each framework (packages/widget-npm).
 * Every way loads the one stub from this server, so they behave the same.
 */
export function InstallWays({ uid }: { uid: string }) {
  const host = location.origin;
  const props = `host="${host}" site="${uid}"`;
  return (
    <Tabs defaultValue="html" className="gap-3">
      <TabsList className="w-full">
        <TabsTrigger value="html">HTML</TabsTrigger>
        <TabsTrigger value="next">Next.js</TabsTrigger>
        <TabsTrigger value="react">React</TabsTrigger>
        <TabsTrigger value="vue">Vue</TabsTrigger>
        <TabsTrigger value="js">JS</TabsTrigger>
      </TabsList>

      <TabsContent value="html" className="flex flex-col gap-2">
        <CodeBlock code={installTag(uid)} label="Copy the tag" />
        <Note>
          Paste it before <code className="font-mono">&lt;/body&gt;</code> on every page you want reviewed. On WordPress,
          Webflow, Framer or Squarespace, put it in the site's footer or custom code setting.
        </Note>
      </TabsContent>

      <TabsContent value="next" className="flex flex-col gap-2">
        <CodeBlock code={NPM} label="Copy the install command" />
        <CodeBlock
          code={`// app/layout.tsx\nimport { Snagset } from "snagset/next";\n\n<body>\n  {children}\n  <Snagset ${props} />\n</body>`}
          label="Copy the Next.js code"
        />
        <Note>It renders the tag on the server, so it adds no client JavaScript.</Note>
      </TabsContent>

      <TabsContent value="react" className="flex flex-col gap-2">
        <CodeBlock code={NPM} label="Copy the install command" />
        <CodeBlock code={`import Snagset from "snagset/react";\n\n<Snagset ${props} />`} label="Copy the React code" />
        <Note>Put it once, near the root of the app.</Note>
      </TabsContent>

      <TabsContent value="vue" className="flex flex-col gap-2">
        <CodeBlock code={NPM} label="Copy the install command" />
        <CodeBlock
          code={`<script setup>\nimport Snagset from "snagset/vue";\n</script>\n\n<template>\n  <Snagset ${props} />\n</template>`}
          label="Copy the Vue code"
        />
        <Note>Put it once, in the root component.</Note>
      </TabsContent>

      <TabsContent value="js" className="flex flex-col gap-2">
        <CodeBlock code={NPM} label="Copy the install command" />
        <CodeBlock
          code={`import snagset from "snagset";\n\nsnagset.init({ host: "${host}", site: "${uid}" });`}
          label="Copy the JavaScript code"
        />
        <Note>For any other bundler or framework.</Note>
      </TabsContent>
    </Tabs>
  );
}
