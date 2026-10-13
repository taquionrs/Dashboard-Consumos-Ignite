import { headers } from "next/headers";
import Dashboard from "./components/Dashboard";
import { readSession } from "@/lib/access";

export default function Page() {
  return <Dashboard session={readSession(headers())} />;
}
