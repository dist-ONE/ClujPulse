import requests
import zipfile
import io
import os

URL = "https://external.gtfs.ro/cluj/CLUJ.zip"

def extract_data(city_name="cluj"):
    os.makedirs(f"data/raw/{city_name}", exist_ok=True)

    print(f"Downloading GTFS data for {city_name}")
    response = requests.get(URL)
    if response.status_code == 200:
        print(f"Downloaded successfully GTFS data for {city_name}")

        with zipfile.ZipFile(io.BytesIO(response.content)) as zip_ref:
            zip_ref.extractall(f"data/{city_name}")

        print(f"Extracted data to data/{city_name}")
    else:
        print(f"Failed to download data. Status code: {response.status_code}")

if __name__ == "__main__":
    extract_data()