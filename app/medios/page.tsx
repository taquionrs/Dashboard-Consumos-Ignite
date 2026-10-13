import { headers } from "next/headers";
import MediosView from "../components/MediosView";
import { readSession } from "@/lib/access";

export default function MediosPage() {
  return <MediosView session={readSession(headers())} />;
}
