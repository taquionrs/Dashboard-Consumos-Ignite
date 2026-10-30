import { headers } from "next/headers";
import CortesView from "../components/CortesView";
import { readSession } from "@/lib/access";

export default function CortesPage() {
  return <CortesView session={readSession(headers())} />;
}
