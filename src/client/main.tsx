import { render } from "@solidjs/web";
import App from "./App";
import "./theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("Eryn needs a #root element");

render(() => <App />, root);
