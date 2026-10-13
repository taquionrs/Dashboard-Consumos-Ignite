import { headers } from "next/headers";
import AlertasView from "../../components/AlertasView";
import { readSession } from "@/lib/access";

export default function AlertasPage() {
  return <AlertasView session={readSession(headers())} />;
}
