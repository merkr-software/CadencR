import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Progress,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@cadencr/tab-kit";
import "./styles.css";

function Example() {
  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="flex items-center gap-2">
        <h1 className="text-sm font-semibold">Changed files</h1>
        <Badge variant="secondary">12</Badge>
        <span className="font-mono text-xs">
          <span className="text-numstat-add-fg">+42</span>{" "}
          <span className="text-numstat-del-fg">−7</span>
        </span>
      </header>
      <pre className="font-mono text-xs">
        <span className="block bg-diff-add-bg">+ added line</span>
        <span className="block bg-diff-del-bg">- removed line</span>
      </pre>
      <Tabs defaultValue="graph">
        <TabsList>
          <TabsTrigger value="graph">Graph</TabsTrigger>
          <TabsTrigger value="list">List</TabsTrigger>
        </TabsList>
        <TabsContent value="graph" className="text-muted-foreground">
          Graph view
        </TabsContent>
        <TabsContent value="list">List view</TabsContent>
      </Tabs>
      <div className="flex items-center gap-2">
        <Input placeholder="Filter" />
        <Switch aria-label="Group by directory" />
        <Button>Refresh</Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <Progress value={40} />
        </CardContent>
      </Card>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");
createRoot(root).render(
  <StrictMode>
    <Example />
  </StrictMode>,
);
