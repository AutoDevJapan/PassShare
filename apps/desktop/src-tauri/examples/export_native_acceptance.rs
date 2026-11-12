#[path = "../src/commercial_export.rs"]
mod commercial_export;
use std::{
    io::{BufRead, Write},
    sync::{Arc, Mutex},
};
fn main() {
    let publisher = std::env::var_os("PASSSHARE_TEST_PUBLISHER").expect("test publisher required");
    let sessions = Arc::new(commercial_export::ExportSessions::default());
    let gate = Arc::new(Mutex::new(()));
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let mut tasks = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        let s = sessions.clone();
        let g = gate.clone();
        let o = output.clone();
        let p = publisher.clone();
        tasks.push(std::thread::spawn(move||{let id=request["id"].clone();let a=&request["args"];let token=a["sessionId"].as_str().unwrap_or("");let result:Result<serde_json::Value,String>=(||match request["command"].as_str().unwrap(){"commercial_export_open"=>s.open(a["directory"].as_str().unwrap().into(),1).map(serde_json::Value::String),"commercial_export_identity"=>s.identity(token).map(serde_json::Value::String),"commercial_export_read"=>s.read(token,a["name"].as_str().unwrap(),1).map(|v|serde_json::json!(v)),"commercial_export_publish"=>s.publish_ordered(token,a["name"].as_str().unwrap(),serde_json::from_value(a["bytes"].clone()).unwrap(),1,std::path::Path::new(&p),||true,&g).map(|_|serde_json::Value::Null),"commercial_export_cancel"=>s.cancel(token,&g).map(|_|serde_json::Value::Null),"commercial_export_close"=>s.close(token).map(|_|serde_json::Value::Null),"commercial_export_recover"=>s.recover(token).map(serde_json::Value::Bool),_=>Err("UNKNOWN_COMMAND".into())})();let mut out=o.lock().unwrap();writeln!(out,"{}",serde_json::json!({"id":id,"ok":result.is_ok(),"value":result.as_ref().ok(),"error":result.err()})).unwrap();out.flush().unwrap();}));
    }
    for task in tasks {
        task.join().unwrap();
    }
}
